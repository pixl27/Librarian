/*
 * PartyWin.dll replacement: the PlayFab Party C API, backed by our own relay.
 *
 * Monster Hunter Wilds statically imports 48 functions from PartyWin.dll. That
 * DLL is a client for Microsoft's Azure relay, and reaching the relay needs a
 * PlayFab title login that only a genuine Steam ticket can obtain. Nothing in
 * the game cares *who* carries the packets, only that the Party API behaves as
 * documented, so this DLL implements that API and carries them through
 * tools/wilds-private-server/party-relay.js instead.
 *
 * The API is written against the vendored Party_c.h (PlayFab/PlayFabParty, MIT),
 * and the ordering of state changes follows Microsoft's own sample
 * (reference/NetworkManager.cpp): CreateNewNetwork and ConnectToNetwork hand
 * back their objects synchronously, everything else completes through
 * StartProcessingStateChanges.
 *
 * Voice chat is intentionally absent. Chat controls exist and complete every
 * call so the game's setup path runs, but no audio is captured or carried.
 *
 * Network descriptors are self-describing: "LBP1:<network id>@<host>:<port>".
 * Whoever joins learns the relay address from the descriptor the host published
 * through the game's own session service, so joiners need no configuration.
 * The host chooses the address: librarian_party.ini next to the DLL
 * ([party] relay=host:port) or the LIBRARIAN_PARTY_RELAY environment variable.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#include <sal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <string>
#include <vector>
#include <deque>
#include <map>
#include <set>
#include <mutex>
#include <thread>
#include <atomic>
#include <algorithm>

#include "Party_c.h"

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "bcrypt.lib")

/* ---- errors ------------------------------------------------------------ */
static const PartyError kErrFailed = 0x1000;
static const PartyError kErrInvalidArg = 0x1001;
static const PartyError kErrNotInitialized = 0x1002;
static const PartyError kErrUnsupported = 0x1003;

/* ---- wire protocol (mirrors party-relay.js) ------------------------------ */
enum : uint8_t {
    kJoin = 1, kCreateEndpoint = 2, kDestroyEndpoint = 3, kMessage = 4, kLeave = 5,
    kJoinOk = 101, kJoinErr = 102, kDeviceJoined = 103, kDeviceLeft = 104,
    kEndpointCreated = 105, kEndpointDestroyed = 106, kMessageOut = 107, kEndpointAssigned = 108,
};
static const size_t kConfigWords = 6;
static const uint32_t kMaxFrame = 8u * 1024u * 1024u;

struct Out {
    std::vector<uint8_t> b;
    Out& u8(uint32_t v) { b.push_back((uint8_t)v); return *this; }
    Out& u16(uint32_t v) { b.push_back((uint8_t)v); b.push_back((uint8_t)(v >> 8)); return *this; }
    Out& u32(uint32_t v) { for (int i = 0; i < 4; i++) b.push_back((uint8_t)(v >> (8 * i))); return *this; }
    Out& str(const std::string& s) { u8((uint32_t)std::min<size_t>(s.size(), 255)); b.insert(b.end(), s.begin(), s.begin() + std::min<size_t>(s.size(), 255)); return *this; }
    Out& blob(const void* p, uint32_t n) { u32(n); const uint8_t* c = (const uint8_t*)p; b.insert(b.end(), c, c + n); return *this; }
    std::vector<uint8_t> frame(uint8_t type) const {
        std::vector<uint8_t> f;
        uint32_t len = (uint32_t)b.size() + 1;
        for (int i = 0; i < 4; i++) f.push_back((uint8_t)(len >> (8 * i)));
        f.push_back(type);
        f.insert(f.end(), b.begin(), b.end());
        return f;
    }
};

struct In {
    const uint8_t* p; size_t n; size_t pos = 0; bool bad = false;
    In(const uint8_t* p_, size_t n_) : p(p_), n(n_) {}
    bool need(size_t k) { if (pos + k > n) { bad = true; return false; } return true; }
    uint32_t u8() { if (!need(1)) return 0; return p[pos++]; }
    uint32_t u16() { if (!need(2)) return 0; uint32_t v = p[pos] | (p[pos + 1] << 8); pos += 2; return v; }
    uint32_t u32() { if (!need(4)) return 0; uint32_t v = p[pos] | (p[pos + 1] << 8) | (p[pos + 2] << 16) | ((uint32_t)p[pos + 3] << 24); pos += 4; return v; }
    std::string str() { uint32_t k = u8(); if (!need(k)) return {}; std::string s((const char*)p + pos, k); pos += k; return s; }
    std::vector<uint8_t> blob() { uint32_t k = u32(); if (!need(k)) return {}; std::vector<uint8_t> v(p + pos, p + pos + k); pos += k; return v; }
};

/* ---- objects behind the opaque handles ------------------------------------ */
struct PARTY_LOCAL_USER { std::string entityId; std::string token; };
struct PARTY_DEVICE { uint32_t id = 0; bool local = false; std::string entityId; };
struct PARTY_NETWORK;
struct PARTY_ENDPOINT {
    uint32_t id = 0;            /* assigned by the relay; 0 until then */
    uint32_t req = 0;           /* local creation request, matches ENDPOINT_ASSIGNED */
    PARTY_DEVICE* device = nullptr;
    PARTY_NETWORK* network = nullptr;
    PARTY_LOCAL_USER* user = nullptr;
    std::string entityId;
    bool local = false;
    void* context = nullptr;
    void* asyncIdentifier = nullptr;
};
struct PARTY_CHAT_CONTROL {
    PARTY_LOCAL_USER* user = nullptr;
    PARTY_DEVICE* device = nullptr;
    std::string entityId;
    bool local = false;
    bool muted = false;
    bool connected = false;
    float volume = 1.0f;
};
struct PARTY_AUDIO_MANIPULATION_SOURCE_STREAM { int unused = 0; };

struct AuthRequest { PARTY_LOCAL_USER* user; std::string invitation; void* async; };
struct ChatRequest { PARTY_CHAT_CONTROL* chat; void* async; };

struct PARTY_NETWORK {
    PARTY_NETWORK_DESCRIPTOR desc = {};
    std::string networkId, host, entityId;
    uint16_t port = 0;
    bool create = false;
    uint32_t config[kConfigWords] = {};
    SOCKET sock = INVALID_SOCKET;
    std::thread rx;
    std::mutex sendMu;
    std::vector<uint8_t> pendingOut;     /* frames written before the socket connected */
    bool connected = false;
    std::atomic<bool> joined{false};
    std::atomic<bool> leaving{false};
    std::atomic<bool> dead{false};
    void* connectAsync = nullptr;
    uint32_t localDeviceId = 0;
    std::vector<AuthRequest> authRequests;
    std::vector<ChatRequest> chatRequests;          /* ConnectChatControl issued before the network was joined */
    std::map<uint32_t, PARTY_DEVICE*> devices;
    std::vector<PARTY_ENDPOINT*> endpoints;          /* announced, local and remote */
    std::vector<PARTY_ENDPOINT*> localPending;       /* created locally, id not assigned yet */
    std::map<uint32_t, PARTY_ENDPOINT*> byId;
    std::vector<PARTY_CHAT_CONTROL*> chats;
};

struct PARTY { std::string titleId; };

/* ---- state change plumbing ----------------------------------------------- */
struct SC {
    std::vector<uint8_t> raw;
    std::deque<std::string> strs;
    std::vector<uint8_t> blob;
    std::vector<PARTY_ENDPOINT_HANDLE> eps;
    std::vector<PARTY_DATA_BUFFER> bufs;
    std::vector<PARTY_REGION> regions;
    PARTY_NETWORK_CONFIGURATION cfg = {};
    const char* keep(const std::string& s) { strs.push_back(s); return strs.back().c_str(); }
};

template <class T> static T* newSC(SC*& sc, uint32_t type) {
    sc = new SC;
    sc->raw.assign(sizeof(T), 0);
    T* p = (T*)sc->raw.data();
    ((PARTY_STATE_CHANGE*)p)->stateChangeType = type;
    return p;
}

static struct Globals {
    std::recursive_mutex mu;            /* object state */
    std::mutex qmu;                     /* state change queue; never held while taking mu */
    std::deque<SC*> queue;
    std::vector<SC*> inflight;
    std::vector<const PARTY_STATE_CHANGE*> ptrs;
    bool initialized = false;
    bool wsa = false;
    PARTY handle;
    PARTY_DEVICE localDevice;
    std::vector<PARTY_LOCAL_USER*> users;
    std::vector<PARTY_NETWORK*> networks;
    std::vector<PARTY_CHAT_CONTROL*> chats;
    std::map<std::string, std::vector<uint32_t>> createdNetworks;   /* id -> config words */
    std::vector<const PARTY_LOCAL_USER*> usersView;
    std::vector<const PARTY_NETWORK*> networksView;
    std::vector<const PARTY_ENDPOINT*> endpointsView;
    std::vector<const PARTY_CHAT_CONTROL*> chatsView;
    uint32_t nextReq = 1;
    PARTY_MEM_ALLOC_FUNC allocFn = nullptr;
    PARTY_MEM_FREE_FUNC freeFn = nullptr;
    PARTY_AUDIO_MANIPULATION_SOURCE_STREAM voiceStream;
    std::string logPath;
    std::mutex logMu;
} G;

static void logf(const char* fmt, ...) {
    if (G.logPath.empty()) return;
    char msg[1024];
    va_list ap; va_start(ap, fmt); vsnprintf(msg, sizeof msg, fmt, ap); va_end(ap);
    SYSTEMTIME t; GetLocalTime(&t);
    std::lock_guard<std::mutex> l(G.logMu);
    FILE* f = nullptr;
    if (fopen_s(&f, G.logPath.c_str(), "ab") == 0 && f) {
        fprintf(f, "[%02d:%02d:%02d.%03d] %s\r\n", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, msg);
        fclose(f);
    }
}

/* Per-call-site trace: the first few calls, then every 500th, so per-frame getters cannot flood the log. */
#define TRACE_CALL(name) do { static std::atomic<unsigned> n_{0}; unsigned k_ = ++n_; if (k_ <= 6 || k_ % 500 == 0) logf("call %s #%u", name, k_); } while (0)

static void push(SC* sc) {
    std::lock_guard<std::mutex> l(G.qmu);
    G.queue.push_back(sc);
}

static std::string moduleDir() {
    HMODULE self = nullptr;
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCSTR)&moduleDir, &self);
    char path[MAX_PATH] = {};
    GetModuleFileNameA(self, path, MAX_PATH);
    std::string s(path);
    size_t cut = s.find_last_of("\\/");
    return cut == std::string::npos ? std::string(".") : s.substr(0, cut);
}

static bool relayFromConfig(std::string& host, uint16_t& port) {
    host = "127.0.0.1"; port = 7777;
    char buf[256] = {};
    std::string spec;
    DWORD n = GetEnvironmentVariableA("LIBRARIAN_PARTY_RELAY", buf, sizeof buf);
    if (n > 0 && n < sizeof buf) spec = buf;
    if (spec.empty()) {
        std::string ini = moduleDir() + "\\librarian_party.ini";
        GetPrivateProfileStringA("party", "relay", "", buf, sizeof buf, ini.c_str());
        spec = buf;
    }
    if (spec.empty()) return true;
    size_t colon = spec.rfind(':');
    if (colon == std::string::npos) { host = spec; return true; }
    host = spec.substr(0, colon);
    int p = atoi(spec.c_str() + colon + 1);
    if (host.empty() || p <= 0 || p > 65535) return false;
    port = (uint16_t)p;
    return true;
}

static std::string newGuid() {
    uint8_t b[16] = {};
    BCryptGenRandom(nullptr, b, sizeof b, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    b[6] = (b[6] & 0x0F) | 0x40; b[8] = (b[8] & 0x3F) | 0x80;
    char s[40];
    snprintf(s, sizeof s, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
    return s;
}

/* ---- network I/O ----------------------------------------------------------- */
static bool sendAll(SOCKET s, const uint8_t* p, size_t n) {
    while (n) {
        int k = send(s, (const char*)p, (int)std::min<size_t>(n, 1 << 20), 0);
        if (k <= 0) return false;
        p += k; n -= (size_t)k;
    }
    return true;
}

static void sendFrame(PARTY_NETWORK* n, const std::vector<uint8_t>& f) {
    std::lock_guard<std::mutex> l(n->sendMu);
    if (!n->connected) { n->pendingOut.insert(n->pendingOut.end(), f.begin(), f.end()); return; }
    if (n->sock != INVALID_SOCKET) sendAll(n->sock, f.data(), f.size());
}

static void queueConnectResult(PARTY_NETWORK* n, PARTY_STATE_CHANGE_RESULT result, PartyError detail) {
    SC* sc; auto* c = newSC<PARTY_CONNECT_TO_NETWORK_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CONNECT_TO_NETWORK_COMPLETED);
    c->result = result; c->errorDetail = detail; c->networkDescriptor = n->desc;
    c->asyncIdentifier = n->connectAsync; c->network = n;
    push(sc);
}

static void queueNetworkDestroyed(PARTY_NETWORK* n, PARTY_DESTROYED_REASON reason) {
    SC* sc; auto* c = newSC<PARTY_NETWORK_DESTROYED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_NETWORK_DESTROYED);
    c->reason = reason; c->network = n;
    push(sc);
}

static void queueAuthCompleted(PARTY_NETWORK* n, const AuthRequest& a) {
    SC* sc; auto* c = newSC<PARTY_AUTHENTICATE_LOCAL_USER_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_AUTHENTICATE_LOCAL_USER_COMPLETED);
    c->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; c->network = n; c->localUser = a.user;
    c->invitationIdentifier = sc->keep(a.invitation); c->asyncIdentifier = a.async;
    push(sc);
}

static void queueEndpointCreated(PARTY_NETWORK* n, PARTY_ENDPOINT* ep) {
    SC* sc; auto* c = newSC<PARTY_ENDPOINT_CREATED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_ENDPOINT_CREATED);
    c->network = n; c->endpoint = ep;
    push(sc);
}

static void queueChatConnected(PARTY_NETWORK* n, PARTY_CHAT_CONTROL* c, void* async) {
    c->connected = true;
    if (std::find(n->chats.begin(), n->chats.end(), c) == n->chats.end()) n->chats.push_back(c);
    SC* sc; auto* a = newSC<PARTY_CONNECT_CHAT_CONTROL_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CONNECT_CHAT_CONTROL_COMPLETED);
    a->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; a->network = n; a->localChatControl = c; a->asyncIdentifier = async; push(sc);
    auto* b = newSC<PARTY_CHAT_CONTROL_JOINED_NETWORK_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CHAT_CONTROL_JOINED_NETWORK);
    b->network = n; b->chatControl = c; push(sc);
}

static PARTY_DEVICE* deviceFor(PARTY_NETWORK* n, uint32_t id, const std::string& entity) {
    auto it = n->devices.find(id);
    if (it != n->devices.end()) return it->second;
    PARTY_DEVICE* d = new PARTY_DEVICE;
    d->id = id; d->entityId = entity;
    n->devices[id] = d;
    return d;
}

/* Everything below runs on the receive thread, under G.mu. */
static void onFrame(PARTY_NETWORK* n, uint8_t type, In& r) {
    switch (type) {
    case kJoinOk: {
        n->localDeviceId = r.u32();
        for (size_t i = 0; i < kConfigWords; i++) n->config[i] = r.u32();
        n->joined = true;
        queueConnectResult(n, PARTY_STATE_CHANGE_RESULT_SUCCEEDED, 0);
        for (auto& a : n->authRequests) queueAuthCompleted(n, a);
        n->authRequests.clear();
        for (auto& r : n->chatRequests) queueChatConnected(n, r.chat, r.async);
        n->chatRequests.clear();
        SC* sc; auto* c = newSC<PARTY_NETWORK_CONFIGURATION_MADE_AVAILABLE_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_NETWORK_CONFIGURATION_MADE_AVAILABLE);
        sc->cfg.maxUserCount = n->config[0]; sc->cfg.maxDeviceCount = n->config[1];
        sc->cfg.maxUsersPerDeviceCount = n->config[2]; sc->cfg.maxDevicesPerUserCount = n->config[3];
        sc->cfg.maxEndpointsPerDeviceCount = n->config[4];
        sc->cfg.directPeerConnectivityOptions = (PARTY_DIRECT_PEER_CONNECTIVITY_OPTIONS)n->config[5];
        c->network = n; c->networkConfiguration = &sc->cfg;
        push(sc);
        logf("joined %s as device %u", n->networkId.c_str(), n->localDeviceId);
        break;
    }
    case kJoinErr: {
        uint32_t code = r.u8();
        logf("join refused for %s (code %u)", n->networkId.c_str(), code);
        queueConnectResult(n, code == 1 ? PARTY_STATE_CHANGE_RESULT_NETWORK_NO_LONGER_EXISTS : PARTY_STATE_CHANGE_RESULT_NETWORK_LIMIT_REACHED, kErrFailed);
        queueNetworkDestroyed(n, PARTY_DESTROYED_REASON_CREATION_FAILED);
        n->dead = true;
        break;
    }
    case kDeviceJoined: {
        uint32_t id = r.u32(); std::string entity = r.str();
        PARTY_DEVICE* d = deviceFor(n, id, entity);
        SC* sc; auto* a = newSC<PARTY_REMOTE_DEVICE_CREATED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_REMOTE_DEVICE_CREATED);
        a->device = d; push(sc);
        auto* b = newSC<PARTY_REMOTE_DEVICE_JOINED_NETWORK_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_REMOTE_DEVICE_JOINED_NETWORK);
        b->device = d; b->network = n; push(sc);
        break;
    }
    case kDeviceLeft: {
        uint32_t id = r.u32();
        auto it = n->devices.find(id);
        if (it == n->devices.end()) break;
        SC* sc; auto* a = newSC<PARTY_REMOTE_DEVICE_LEFT_NETWORK_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_REMOTE_DEVICE_LEFT_NETWORK);
        a->reason = PARTY_DESTROYED_REASON_DISCONNECTED; a->device = it->second; a->network = n; push(sc);
        auto* b = newSC<PARTY_REMOTE_DEVICE_DESTROYED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_REMOTE_DEVICE_DESTROYED);
        b->device = it->second; push(sc);
        n->devices.erase(it);
        break;
    }
    case kEndpointCreated: {
        uint32_t id = r.u32(); uint32_t dev = r.u32(); std::string entity = r.str();
        PARTY_ENDPOINT* ep = new PARTY_ENDPOINT;
        ep->id = id; ep->network = n; ep->device = deviceFor(n, dev, entity); ep->entityId = entity; ep->local = false;
        n->byId[id] = ep; n->endpoints.push_back(ep);
        queueEndpointCreated(n, ep);
        break;
    }
    case kEndpointDestroyed: {
        uint32_t id = r.u32();
        auto it = n->byId.find(id);
        if (it == n->byId.end()) break;
        PARTY_ENDPOINT* ep = it->second;
        n->byId.erase(it);
        n->endpoints.erase(std::remove(n->endpoints.begin(), n->endpoints.end(), ep), n->endpoints.end());
        SC* sc; auto* c = newSC<PARTY_ENDPOINT_DESTROYED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_ENDPOINT_DESTROYED);
        c->network = n; c->endpoint = ep; c->reason = PARTY_DESTROYED_REASON_DISCONNECTED; push(sc);
        break;
    }
    case kEndpointAssigned: {
        uint32_t req = r.u32(); uint32_t id = r.u32();
        for (auto it = n->localPending.begin(); it != n->localPending.end(); ++it) {
            if ((*it)->req != req) continue;
            PARTY_ENDPOINT* ep = *it;
            n->localPending.erase(it);
            ep->id = id; n->byId[id] = ep; n->endpoints.push_back(ep);
            SC* sc; auto* c = newSC<PARTY_CREATE_ENDPOINT_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CREATE_ENDPOINT_COMPLETED);
            c->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; c->network = n; c->localUser = ep->user;
            c->asyncIdentifier = ep->asyncIdentifier; c->localEndpoint = ep; push(sc);
            queueEndpointCreated(n, ep);
            break;
        }
        break;
    }
    case kMessageOut: {
        uint32_t src = r.u32(); uint32_t count = r.u16();
        std::vector<uint32_t> ids; for (uint32_t i = 0; i < count; i++) ids.push_back(r.u32());
        uint32_t options = r.u32();
        std::vector<uint8_t> body = r.blob();
        if (r.bad) break;
        auto s = n->byId.find(src);
        if (s == n->byId.end()) break;
        SC* sc; auto* c = newSC<PARTY_ENDPOINT_MESSAGE_RECEIVED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_ENDPOINT_MESSAGE_RECEIVED);
        for (uint32_t id : ids) { auto t = n->byId.find(id); if (t != n->byId.end()) sc->eps.push_back(t->second); }
        sc->blob = body;
        c->network = n; c->senderEndpoint = s->second;
        c->receiverEndpointCount = (uint32_t)sc->eps.size();
        c->receiverEndpoints = sc->eps.data();
        c->options = (PARTY_MESSAGE_RECEIVED_OPTIONS)(options & 3);
        c->messageSize = (uint32_t)sc->blob.size();
        c->messageBuffer = sc->blob.data();
        push(sc);
        break;
    }
    default:
        logf("unknown frame %u", type);
    }
}

static void connectionLost(PARTY_NETWORK* n) {
    if (n->dead || n->leaving) return;
    n->dead = true;
    logf("connection to relay lost for %s", n->networkId.c_str());
    for (PARTY_ENDPOINT* ep : n->endpoints) {
        SC* sc; auto* c = newSC<PARTY_ENDPOINT_DESTROYED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_ENDPOINT_DESTROYED);
        c->network = n; c->endpoint = ep; c->reason = PARTY_DESTROYED_REASON_DISCONNECTED; push(sc);
    }
    n->endpoints.clear(); n->byId.clear();
    queueNetworkDestroyed(n, PARTY_DESTROYED_REASON_DISCONNECTED);
}

static SOCKET connectTo(PARTY_NETWORK* n) {
    addrinfo hints = {}; hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM; hints.ai_protocol = IPPROTO_TCP;
    addrinfo* res = nullptr;
    char portStr[8]; snprintf(portStr, sizeof portStr, "%u", n->port);
    if (getaddrinfo(n->host.c_str(), portStr, &hints, &res) != 0 || !res) return INVALID_SOCKET;
    SOCKET got = INVALID_SOCKET;
    for (addrinfo* a = res; a && got == INVALID_SOCKET; a = a->ai_next) {
        SOCKET s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s == INVALID_SOCKET) continue;
        u_long nb = 1; ioctlsocket(s, FIONBIO, &nb);
        connect(s, a->ai_addr, (int)a->ai_addrlen);
        bool ok = false;
        for (int waited = 0; waited < 8000 && !n->leaving; waited += 100) {
            fd_set w, e; FD_ZERO(&w); FD_ZERO(&e); FD_SET(s, &w); FD_SET(s, &e);
            timeval tv = { 0, 100 * 1000 };
            int k = select(0, nullptr, &w, &e, &tv);
            if (k > 0) { ok = FD_ISSET(s, &w) && !FD_ISSET(s, &e); break; }
        }
        if (!ok) { closesocket(s); continue; }
        nb = 0; ioctlsocket(s, FIONBIO, &nb);
        got = s;
    }
    freeaddrinfo(res);
    return got;
}

static void netThread(PARTY_NETWORK* n) {
    SOCKET s = connectTo(n);
    if (s == INVALID_SOCKET) {
        std::lock_guard<std::recursive_mutex> l(G.mu);
        if (!n->leaving) {
            logf("cannot reach relay %s:%u", n->host.c_str(), n->port);
            queueConnectResult(n, PARTY_STATE_CHANGE_RESULT_INTERNET_CONNECTIVITY_ERROR, kErrFailed);
            queueNetworkDestroyed(n, PARTY_DESTROYED_REASON_CREATION_FAILED);
        }
        n->dead = true;
        return;
    }
    BOOL nd = TRUE; setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char*)&nd, sizeof nd);
    {
        std::lock_guard<std::mutex> l(n->sendMu);
        n->sock = s;
        Out j; j.u8(n->create ? 1 : 0).str(n->networkId).str(n->entityId);
        for (size_t i = 0; i < kConfigWords; i++) j.u32(n->config[i]);
        std::vector<uint8_t> f = j.frame(kJoin);
        sendAll(s, f.data(), f.size());
        if (!n->pendingOut.empty()) { sendAll(s, n->pendingOut.data(), n->pendingOut.size()); n->pendingOut.clear(); }
        n->connected = true;
    }
    std::vector<uint8_t> buf;
    uint8_t chunk[16384];
    for (;;) {
        int k = recv(s, (char*)chunk, sizeof chunk, 0);
        if (k <= 0) break;
        buf.insert(buf.end(), chunk, chunk + k);
        size_t pos = 0;
        std::lock_guard<std::recursive_mutex> l(G.mu);
        while (buf.size() - pos >= 4) {
            uint32_t len = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | ((uint32_t)buf[pos + 3] << 24);
            if (len < 1 || len > kMaxFrame) { pos = buf.size(); break; }
            if (buf.size() - pos < 4 + (size_t)len) break;
            In r(buf.data() + pos + 5, len - 1);
            onFrame(n, buf[pos + 4], r);
            pos += 4 + (size_t)len;
        }
        buf.erase(buf.begin(), buf.begin() + pos);
    }
    std::lock_guard<std::recursive_mutex> l(G.mu);
    connectionLost(n);
}

/* ---- descriptors ------------------------------------------------------------ */
static const char kMagic[] = "LBP1";

static void fillDescriptor(PARTY_NETWORK_DESCRIPTOR* d, const std::string& id, const std::string& host, uint16_t port) {
    memset(d, 0, sizeof *d);
    strncpy_s(d->networkIdentifier, sizeof d->networkIdentifier, id.c_str(), _TRUNCATE);
    strncpy_s(d->regionName, sizeof d->regionName, "librarian", _TRUNCATE);
    char info[128];
    snprintf(info, sizeof info, "%s%s:%u", kMagic, host.c_str(), port);
    memcpy(d->opaqueConnectionInformation, info, strlen(info) + 1);
}

static bool readDescriptor(const PARTY_NETWORK_DESCRIPTOR* d, std::string& id, std::string& host, uint16_t& port) {
    const char* info = (const char*)d->opaqueConnectionInformation;
    if (memcmp(info, kMagic, 4) != 0) return false;
    std::string spec(info + 4, strnlen(info + 4, 200));
    size_t colon = spec.rfind(':');
    if (colon == std::string::npos || colon == 0) return false;
    int p = atoi(spec.c_str() + colon + 1);
    if (p <= 0 || p > 65535) return false;
    host = spec.substr(0, colon); port = (uint16_t)p;
    id.assign(d->networkIdentifier, strnlen(d->networkIdentifier, PARTY_NETWORK_IDENTIFIER_STRING_LENGTH));
    return !id.empty();
}

/* ---- the API ------------------------------------------------------------------ */
extern "C" {

PartyError PARTY_API PartyInitialize(PartyString titleId, PARTY_HANDLE* handle) {
    TRACE_CALL("PartyInitialize");
    if (!handle) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    if (G.logPath.empty()) G.logPath = moduleDir() + "\\librarian_party.log";
    if (!G.wsa) { WSADATA w; if (WSAStartup(MAKEWORD(2, 2), &w) != 0) return kErrFailed; G.wsa = true; }
    G.handle.titleId = titleId ? titleId : "";
    G.localDevice.local = true;
    G.initialized = true;
    *handle = &G.handle;
    logf("PartyInitialize title=%s", G.handle.titleId.c_str());
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyCleanup(PARTY_HANDLE handle) {
    TRACE_CALL("PartyCleanup");
    if (handle != &G.handle) return kErrInvalidArg;
    std::vector<PARTY_NETWORK*> nets;
    {
        std::lock_guard<std::recursive_mutex> l(G.mu);
        nets = G.networks;
        for (auto* n : nets) { n->leaving = true; if (n->sock != INVALID_SOCKET) shutdown(n->sock, SD_BOTH); }
    }
    for (auto* n : nets) if (n->rx.joinable()) n->rx.join();
    std::lock_guard<std::recursive_mutex> l(G.mu);
    for (auto* n : nets) if (n->sock != INVALID_SOCKET) { closesocket(n->sock); n->sock = INVALID_SOCKET; }
    G.networks.clear();
    G.initialized = false;
    logf("PartyCleanup");
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartySetMemoryCallbacks(PARTY_MEM_ALLOC_FUNC a, PARTY_MEM_FREE_FUNC f) {
    TRACE_CALL("PartySetMemoryCallbacks");
    G.allocFn = a; G.freeFn = f;
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyCreateLocalUser(PARTY_HANDLE handle, PartyString entityId, PartyString token, PARTY_LOCAL_USER_HANDLE* out) {
    TRACE_CALL("PartyCreateLocalUser");
    if (handle != &G.handle || !entityId || !out) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    PARTY_LOCAL_USER* u = new PARTY_LOCAL_USER;
    u->entityId = entityId; u->token = token ? token : "";
    G.users.push_back(u);
    if (G.localDevice.entityId.empty()) G.localDevice.entityId = entityId;
    *out = u;
    logf("CreateLocalUser entity=%s", entityId);
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyLocalUserGetEntityId(PARTY_LOCAL_USER_HANDLE u, PartyString* entityId) {
    TRACE_CALL("PartyLocalUserGetEntityId");
    if (!u || !entityId) return kErrInvalidArg;
    *entityId = u->entityId.c_str();
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyLocalUserUpdateEntityToken(PARTY_LOCAL_USER_HANDLE u, PartyString token) {
    TRACE_CALL("PartyLocalUserUpdateEntityToken");
    if (!u) return kErrInvalidArg;
    const_cast<PARTY_LOCAL_USER*>(u)->token = token ? token : "";
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyGetLocalUsers(PARTY_HANDLE handle, uint32_t* count, const PARTY_LOCAL_USER_HANDLE** users) {
    TRACE_CALL("PartyGetLocalUsers");
    if (handle != &G.handle || !count || !users) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    G.usersView.assign(G.users.begin(), G.users.end());
    *count = (uint32_t)G.usersView.size(); *users = G.usersView.data();
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyGetLocalDevice(PARTY_HANDLE handle, PARTY_DEVICE_HANDLE* dev) {
    TRACE_CALL("PartyGetLocalDevice");
    if (handle != &G.handle || !dev) return kErrInvalidArg;
    *dev = &G.localDevice;
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyGetNetworks(PARTY_HANDLE handle, uint32_t* count, const PARTY_NETWORK_HANDLE** nets) {
    TRACE_CALL("PartyGetNetworks");
    if (handle != &G.handle || !count || !nets) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    G.networksView.clear();
    for (auto* n : G.networks) if (!n->dead) G.networksView.push_back(n);
    *count = (uint32_t)G.networksView.size(); *nets = G.networksView.data();
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyStartProcessingStateChanges(PARTY_HANDLE handle, uint32_t* count, const PARTY_STATE_CHANGE* const** changes) {
    if (handle != &G.handle || !count || !changes) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    {
        std::lock_guard<std::mutex> q(G.qmu);
        while (!G.queue.empty()) { G.inflight.push_back(G.queue.front()); G.queue.pop_front(); }
    }
    G.ptrs.clear();
    for (SC* sc : G.inflight) G.ptrs.push_back((const PARTY_STATE_CHANGE*)sc->raw.data());
    *count = (uint32_t)G.ptrs.size();
    *changes = G.ptrs.data();
    if (!G.ptrs.empty()) {
        std::string types;
        for (const PARTY_STATE_CHANGE* sc : G.ptrs) types += std::to_string(sc->stateChangeType) + " ";
        logf("deliver %u state change(s): %s", (unsigned)G.ptrs.size(), types.c_str());
    }
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyFinishProcessingStateChanges(PARTY_HANDLE handle, uint32_t count, const PARTY_STATE_CHANGE* const* changes) {
    if (handle != &G.handle || (count && !changes)) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    for (uint32_t i = 0; i < count; i++) {
        for (auto it = G.inflight.begin(); it != G.inflight.end(); ++it) {
            if ((const PARTY_STATE_CHANGE*)(*it)->raw.data() == changes[i]) { delete *it; G.inflight.erase(it); break; }
        }
    }
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyCreateNewNetwork(PARTY_HANDLE handle, PARTY_LOCAL_USER_HANDLE user, const PARTY_NETWORK_CONFIGURATION* cfg,
    uint32_t regionCount, const PARTY_REGION* regions, const PARTY_INVITATION_CONFIGURATION* invitation, void* async,
    PARTY_NETWORK_DESCRIPTOR* outDescriptor, char* outInvitation) {
    TRACE_CALL("PartyCreateNewNetwork");
    if (handle != &G.handle || !user || !cfg) return kErrInvalidArg;
    std::string host; uint16_t port;
    if (!relayFromConfig(host, port)) return kErrInvalidArg;
    std::string id = newGuid();
    std::vector<uint32_t> words = { cfg->maxUserCount, cfg->maxDeviceCount, cfg->maxUsersPerDeviceCount,
                                    cfg->maxDevicesPerUserCount, cfg->maxEndpointsPerDeviceCount, (uint32_t)cfg->directPeerConnectivityOptions };
    std::string invitationId = (invitation && invitation->identifier) ? invitation->identifier : id;
    {
        std::lock_guard<std::recursive_mutex> l(G.mu);
        G.createdNetworks[id] = words;
    }
    SC* sc; auto* c = newSC<PARTY_CREATE_NEW_NETWORK_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CREATE_NEW_NETWORK_COMPLETED);
    c->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; c->localUser = user; c->networkConfiguration = *cfg;
    if (regionCount && regions) { sc->regions.assign(regions, regions + regionCount); c->regionCount = regionCount; c->regions = sc->regions.data(); }
    c->asyncIdentifier = async;
    fillDescriptor(&c->networkDescriptor, id, host, port);
    c->appliedInitialInvitationIdentifier = sc->keep(invitationId);
    if (outDescriptor) *outDescriptor = c->networkDescriptor;
    if (outInvitation) strncpy_s(outInvitation, PARTY_MAX_INVITATION_IDENTIFIER_STRING_LENGTH + 1, invitationId.c_str(), _TRUNCATE);
    push(sc);
    logf("CreateNewNetwork id=%s relay=%s:%u", id.c_str(), host.c_str(), port);
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyConnectToNetwork(PARTY_HANDLE handle, const PARTY_NETWORK_DESCRIPTOR* d, void* async, PARTY_NETWORK_HANDLE* out) {
    TRACE_CALL("PartyConnectToNetwork");
    if (handle != &G.handle || !d) return kErrInvalidArg;
    PARTY_NETWORK* n = new PARTY_NETWORK;
    n->desc = *d;
    if (!readDescriptor(d, n->networkId, n->host, n->port)) { delete n; return kErrInvalidArg; }
    n->connectAsync = async;
    {
        std::lock_guard<std::recursive_mutex> l(G.mu);
        auto made = G.createdNetworks.find(n->networkId);
        if (made != G.createdNetworks.end()) {
            n->create = true;
            for (size_t i = 0; i < kConfigWords && i < made->second.size(); i++) n->config[i] = made->second[i];
        }
        n->entityId = G.users.empty() ? std::string() : G.users.front()->entityId;
        G.networks.push_back(n);
    }
    n->rx = std::thread(netThread, n);
    if (out) *out = n;
    logf("ConnectToNetwork id=%s relay=%s:%u create=%d", n->networkId.c_str(), n->host.c_str(), n->port, (int)n->create);
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyNetworkAuthenticateLocalUser(PARTY_NETWORK_HANDLE net, PARTY_LOCAL_USER_HANDLE user, PartyString invitation, void* async) {
    TRACE_CALL("PartyNetworkAuthenticateLocalUser");
    if (!net || !user) return kErrInvalidArg;
    PARTY_NETWORK* n = const_cast<PARTY_NETWORK*>(net);
    std::lock_guard<std::recursive_mutex> l(G.mu);
    n->entityId = user->entityId;
    AuthRequest a = { const_cast<PARTY_LOCAL_USER*>(user), invitation ? invitation : "", async };
    if (n->joined) queueAuthCompleted(n, a); else n->authRequests.push_back(a);
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyNetworkGetNetworkDescriptor(PARTY_NETWORK_HANDLE net, PARTY_NETWORK_DESCRIPTOR* d) {
    TRACE_CALL("PartyNetworkGetNetworkDescriptor");
    if (!net || !d) return kErrInvalidArg;
    *d = net->desc;
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyNetworkGetDeviceConnectionType(PARTY_NETWORK_HANDLE net, PARTY_DEVICE_HANDLE dev, PARTY_DEVICE_CONNECTION_TYPE* type) {
    TRACE_CALL("PartyNetworkGetDeviceConnectionType");
    if (!net || !type) return kErrInvalidArg;
    (void)dev;
    *type = PARTY_DEVICE_CONNECTION_TYPE_RELAY_SERVER;
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyNetworkGetEndpoints(PARTY_NETWORK_HANDLE net, uint32_t* count, const PARTY_ENDPOINT_HANDLE** eps) {
    TRACE_CALL("PartyNetworkGetEndpoints");
    if (!net || !count || !eps) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    G.endpointsView.assign(net->endpoints.begin(), net->endpoints.end());
    *count = (uint32_t)G.endpointsView.size(); *eps = G.endpointsView.data();
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyNetworkCreateEndpoint(PARTY_NETWORK_HANDLE net, PARTY_LOCAL_USER_HANDLE user, uint32_t propCount, const PartyString* keys,
    const PARTY_DATA_BUFFER* values, void* async, PARTY_ENDPOINT_HANDLE* out) {
    TRACE_CALL("PartyNetworkCreateEndpoint");
    if (!net) return kErrInvalidArg;
    PARTY_NETWORK* n = const_cast<PARTY_NETWORK*>(net);
    if (n->leaving || n->dead) return kErrFailed;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    PARTY_ENDPOINT* ep = new PARTY_ENDPOINT;
    ep->req = G.nextReq++; ep->device = &G.localDevice; ep->network = n; ep->local = true;
    ep->user = const_cast<PARTY_LOCAL_USER*>(user); ep->entityId = user ? user->entityId : std::string();
    ep->asyncIdentifier = async;
    n->localPending.push_back(ep);
    Out o; o.u32(ep->req).u16(propCount);
    for (uint32_t i = 0; i < propCount; i++) {
        o.str(keys && keys[i] ? keys[i] : "");
        if (values && values[i].buffer) o.blob(values[i].buffer, values[i].bufferByteCount); else o.blob(nullptr, 0);
    }
    sendFrame(n, o.frame(kCreateEndpoint));
    if (out) *out = ep;
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyEndpointSendMessage(PARTY_ENDPOINT_HANDLE from, uint32_t targetCount, const PARTY_ENDPOINT_HANDLE* targets,
    PARTY_SEND_MESSAGE_OPTIONS options, const PARTY_SEND_MESSAGE_QUEUING_CONFIGURATION* queuing, uint32_t bufCount,
    const PARTY_DATA_BUFFER* bufs, void* messageId) {
    TRACE_CALL("PartyEndpointSendMessage");
    (void)queuing;
    if (!from || !from->local || (targetCount && !targets) || (bufCount && !bufs)) return kErrInvalidArg;
    PARTY_NETWORK* n = from->network;
    if (!n || n->leaving || n->dead || from->id == 0) return kErrFailed;
    Out o; o.u32(from->id).u16(targetCount);
    for (uint32_t i = 0; i < targetCount; i++) o.u32(targets[i] ? targets[i]->id : 0);
    uint32_t total = 0;
    for (uint32_t i = 0; i < bufCount; i++) total += bufs[i].bufferByteCount;
    o.u32((uint32_t)options).u32(total);
    for (uint32_t i = 0; i < bufCount; i++) if (bufs[i].bufferByteCount) o.b.insert(o.b.end(), (const uint8_t*)bufs[i].buffer, (const uint8_t*)bufs[i].buffer + bufs[i].bufferByteCount);
    sendFrame(n, o.frame(kMessage));
    if (options & PARTY_SEND_MESSAGE_OPTIONS_DONT_COPY_DATA_BUFFERS) {
        /* The caller asked to keep ownership of its buffers until we hand them back. We copied already, so hand them back now. */
        SC* sc; auto* c = newSC<PARTY_DATA_BUFFERS_RETURNED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_DATA_BUFFERS_RETURNED);
        sc->bufs.assign(bufs, bufs + bufCount);
        c->network = n; c->localSenderEndpoint = from; c->dataBufferCount = bufCount; c->dataBuffers = sc->bufs.data(); c->messageIdentifier = messageId;
        push(sc);
    }
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyNetworkLeaveNetwork(PARTY_NETWORK_HANDLE net, void* async) {
    TRACE_CALL("PartyNetworkLeaveNetwork");
    if (!net) return kErrInvalidArg;
    PARTY_NETWORK* n = const_cast<PARTY_NETWORK*>(net);
    std::lock_guard<std::recursive_mutex> l(G.mu);
    if (n->leaving) return kErrFailed;
    n->leaving = true;
    sendFrame(n, Out().frame(kLeave));
    if (n->joined) {
        for (PARTY_ENDPOINT* ep : n->endpoints) {
            SC* sc; auto* c = newSC<PARTY_ENDPOINT_DESTROYED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_ENDPOINT_DESTROYED);
            c->network = n; c->endpoint = ep; c->reason = PARTY_DESTROYED_REASON_REQUESTED; push(sc);
        }
        for (auto& kv : n->devices) {
            SC* sc; auto* a = newSC<PARTY_REMOTE_DEVICE_LEFT_NETWORK_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_REMOTE_DEVICE_LEFT_NETWORK);
            a->reason = PARTY_DESTROYED_REASON_REQUESTED; a->device = kv.second; a->network = n; push(sc);
            auto* b = newSC<PARTY_REMOTE_DEVICE_DESTROYED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_REMOTE_DEVICE_DESTROYED);
            b->device = kv.second; push(sc);
        }
        for (PARTY_CHAT_CONTROL* cc : n->chats) {
            cc->connected = false;
            SC* sc; auto* c = newSC<PARTY_CHAT_CONTROL_LEFT_NETWORK_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CHAT_CONTROL_LEFT_NETWORK);
            c->reason = PARTY_DESTROYED_REASON_REQUESTED; c->network = n; c->chatControl = cc; push(sc);
        }
    }
    n->endpoints.clear(); n->byId.clear(); n->chats.clear();
    SC* sc; auto* c = newSC<PARTY_LEAVE_NETWORK_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_LEAVE_NETWORK_COMPLETED);
    c->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; c->network = n; c->asyncIdentifier = async; push(sc);
    queueNetworkDestroyed(n, PARTY_DESTROYED_REASON_REQUESTED);
    n->dead = true;
    logf("LeaveNetwork %s", n->networkId.c_str());
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartySerializeNetworkDescriptor(const PARTY_NETWORK_DESCRIPTOR* d, char* out) {
    TRACE_CALL("PartySerializeNetworkDescriptor");
    if (!d || !out) return kErrInvalidArg;
    std::string id, host; uint16_t port;
    if (!readDescriptor(d, id, host, port)) return kErrInvalidArg;
    char s[PARTY_MAX_SERIALIZED_NETWORK_DESCRIPTOR_STRING_LENGTH + 1];
    int k = snprintf(s, sizeof s, "LBP1:%s@%s:%u", id.c_str(), host.c_str(), port);
    if (k <= 0 || k > PARTY_MAX_SERIALIZED_NETWORK_DESCRIPTOR_STRING_LENGTH) return kErrInvalidArg;
    memcpy(out, s, (size_t)k + 1);
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyDeserializeNetworkDescriptor(PartyString s, PARTY_NETWORK_DESCRIPTOR* d) {
    TRACE_CALL("PartyDeserializeNetworkDescriptor");
    if (!s || !d) return kErrInvalidArg;
    std::string in(s);
    if (in.compare(0, 5, "LBP1:") != 0) return kErrInvalidArg;
    size_t at = in.find('@', 5);
    if (at == std::string::npos) return kErrInvalidArg;
    std::string id = in.substr(5, at - 5);
    std::string spec = in.substr(at + 1);
    size_t colon = spec.rfind(':');
    if (id.empty() || id.size() > PARTY_NETWORK_IDENTIFIER_STRING_LENGTH || colon == std::string::npos || colon == 0) return kErrInvalidArg;
    int p = atoi(spec.c_str() + colon + 1);
    if (p <= 0 || p > 65535) return kErrInvalidArg;
    fillDescriptor(d, id, spec.substr(0, colon), (uint16_t)p);
    return c_partyErrorSuccess;
}

/* ---- endpoints ------------------------------------------------------------------ */
PartyError PARTY_API PartyEndpointGetCustomContext(PARTY_ENDPOINT_HANDLE ep, void** ctx) {
    TRACE_CALL("PartyEndpointGetCustomContext");
    if (!ep || !ctx) return kErrInvalidArg;
    *ctx = ep->context;
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyEndpointSetCustomContext(PARTY_ENDPOINT_HANDLE ep, void* ctx) {
    TRACE_CALL("PartyEndpointSetCustomContext");
    if (!ep) return kErrInvalidArg;
    const_cast<PARTY_ENDPOINT*>(ep)->context = ctx;
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyEndpointGetDevice(PARTY_ENDPOINT_HANDLE ep, PARTY_DEVICE_HANDLE* dev) {
    TRACE_CALL("PartyEndpointGetDevice");
    if (!ep || !dev) return kErrInvalidArg;
    *dev = ep->device;
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyEndpointGetEntityId(PARTY_ENDPOINT_HANDLE ep, PartyString* entityId) {
    TRACE_CALL("PartyEndpointGetEntityId");
    if (!ep || !entityId) return kErrInvalidArg;
    *entityId = ep->entityId.empty() ? nullptr : ep->entityId.c_str();
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyEndpointIsLocal(PARTY_ENDPOINT_HANDLE ep, PartyBool* isLocal) {
    TRACE_CALL("PartyEndpointIsLocal");
    if (!ep || !isLocal) return kErrInvalidArg;
    *isLocal = ep->local ? 1 : 0;
    return c_partyErrorSuccess;
}

/* ---- chat controls: present so setup completes, carrying no audio --------------- */
PartyError PARTY_API PartyDeviceCreateChatControl(PARTY_DEVICE_HANDLE dev, PARTY_LOCAL_USER_HANDLE user, PartyString lang, void* async, PARTY_CHAT_CONTROL_HANDLE* out) {
    TRACE_CALL("PartyDeviceCreateChatControl");
    if (!dev || !user) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    PARTY_CHAT_CONTROL* cc = new PARTY_CHAT_CONTROL;
    cc->user = const_cast<PARTY_LOCAL_USER*>(user); cc->device = const_cast<PARTY_DEVICE*>(dev); cc->entityId = user->entityId; cc->local = true;
    G.chats.push_back(cc);
    SC* sc; auto* a = newSC<PARTY_CREATE_CHAT_CONTROL_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CREATE_CHAT_CONTROL_COMPLETED);
    a->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; a->localDevice = dev; a->localUser = user;
    a->languageCode = sc->keep(lang ? lang : ""); a->asyncIdentifier = async; a->localChatControl = cc; push(sc);
    auto* b = newSC<PARTY_CHAT_CONTROL_CREATED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CHAT_CONTROL_CREATED);
    b->chatControl = cc; push(sc);
    if (out) *out = cc;
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyDeviceDestroyChatControl(PARTY_DEVICE_HANDLE dev, PARTY_CHAT_CONTROL_HANDLE cc, void* async) {
    TRACE_CALL("PartyDeviceDestroyChatControl");
    if (!dev || !cc) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    SC* sc; auto* a = newSC<PARTY_DESTROY_CHAT_CONTROL_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_DESTROY_CHAT_CONTROL_COMPLETED);
    a->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; a->localDevice = dev; a->localChatControl = cc; a->asyncIdentifier = async; push(sc);
    auto* b = newSC<PARTY_CHAT_CONTROL_DESTROYED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CHAT_CONTROL_DESTROYED);
    b->chatControl = cc; b->reason = PARTY_DESTROYED_REASON_REQUESTED; push(sc);
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyNetworkConnectChatControl(PARTY_NETWORK_HANDLE net, PARTY_CHAT_CONTROL_HANDLE cc, void* async) {
    TRACE_CALL("PartyNetworkConnectChatControl");
    if (!net || !cc) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    PARTY_NETWORK* n = const_cast<PARTY_NETWORK*>(net);
    PARTY_CHAT_CONTROL* c = const_cast<PARTY_CHAT_CONTROL*>(cc);
    if (n->joined) queueChatConnected(n, c, async); else n->chatRequests.push_back({ c, async });
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyNetworkDisconnectChatControl(PARTY_NETWORK_HANDLE net, PARTY_CHAT_CONTROL_HANDLE cc, void* async) {
    TRACE_CALL("PartyNetworkDisconnectChatControl");
    if (!net || !cc) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    PARTY_NETWORK* n = const_cast<PARTY_NETWORK*>(net);
    PARTY_CHAT_CONTROL* c = const_cast<PARTY_CHAT_CONTROL*>(cc);
    c->connected = false;
    n->chats.erase(std::remove(n->chats.begin(), n->chats.end(), c), n->chats.end());
    SC* sc; auto* a = newSC<PARTY_DISCONNECT_CHAT_CONTROL_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_DISCONNECT_CHAT_CONTROL_COMPLETED);
    a->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; a->network = net; a->localChatControl = cc; a->asyncIdentifier = async; push(sc);
    auto* b = newSC<PARTY_CHAT_CONTROL_LEFT_NETWORK_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CHAT_CONTROL_LEFT_NETWORK);
    b->reason = PARTY_DESTROYED_REASON_REQUESTED; b->network = net; b->chatControl = cc; push(sc);
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyNetworkGetChatControls(PARTY_NETWORK_HANDLE net, uint32_t* count, const PARTY_CHAT_CONTROL_HANDLE** out) {
    TRACE_CALL("PartyNetworkGetChatControls");
    if (!net || !count || !out) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    G.chatsView.assign(net->chats.begin(), net->chats.end());
    *count = (uint32_t)G.chatsView.size(); *out = G.chatsView.data();
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyChatControlSetAudioInput(PARTY_CHAT_CONTROL_HANDLE cc, PARTY_AUDIO_DEVICE_SELECTION_TYPE type, PartyString ctx, void* async) {
    TRACE_CALL("PartyChatControlSetAudioInput");
    if (!cc) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    SC* sc; auto* a = newSC<PARTY_SET_CHAT_AUDIO_INPUT_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_SET_CHAT_AUDIO_INPUT_COMPLETED);
    a->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; a->localChatControl = cc; a->audioDeviceSelectionType = type;
    a->audioDeviceSelectionContext = ctx ? sc->keep(ctx) : nullptr; a->asyncIdentifier = async; push(sc);
    auto* b = newSC<PARTY_LOCAL_CHAT_AUDIO_INPUT_CHANGED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_LOCAL_CHAT_AUDIO_INPUT_CHANGED);
    b->localChatControl = cc; b->state = type == PARTY_AUDIO_DEVICE_SELECTION_TYPE_NONE ? PARTY_AUDIO_INPUT_STATE_NO_INPUT : PARTY_AUDIO_INPUT_STATE_INITIALIZED; push(sc);
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyChatControlSetAudioOutput(PARTY_CHAT_CONTROL_HANDLE cc, PARTY_AUDIO_DEVICE_SELECTION_TYPE type, PartyString ctx, void* async) {
    TRACE_CALL("PartyChatControlSetAudioOutput");
    if (!cc) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    SC* sc; auto* a = newSC<PARTY_SET_CHAT_AUDIO_OUTPUT_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_SET_CHAT_AUDIO_OUTPUT_COMPLETED);
    a->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; a->localChatControl = cc; a->audioDeviceSelectionType = type;
    a->audioDeviceSelectionContext = ctx ? sc->keep(ctx) : nullptr; a->asyncIdentifier = async; push(sc);
    auto* b = newSC<PARTY_LOCAL_CHAT_AUDIO_OUTPUT_CHANGED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_LOCAL_CHAT_AUDIO_OUTPUT_CHANGED);
    b->localChatControl = cc; b->state = type == PARTY_AUDIO_DEVICE_SELECTION_TYPE_NONE ? PARTY_AUDIO_OUTPUT_STATE_NO_OUTPUT : PARTY_AUDIO_OUTPUT_STATE_INITIALIZED; push(sc);
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyChatControlGetAudioInput(PARTY_CHAT_CONTROL_HANDLE cc, PARTY_AUDIO_DEVICE_SELECTION_TYPE* type, PartyString* ctx, PartyString* deviceId) {
    TRACE_CALL("PartyChatControlGetAudioInput");
    if (!cc || !type || !ctx || !deviceId) return kErrInvalidArg;
    *type = PARTY_AUDIO_DEVICE_SELECTION_TYPE_SYSTEM_DEFAULT; *ctx = ""; *deviceId = "";
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyChatControlGetAudioInputMuted(PARTY_CHAT_CONTROL_HANDLE cc, PartyBool* muted) {
    TRACE_CALL("PartyChatControlGetAudioInputMuted");
    if (!cc || !muted) return kErrInvalidArg;
    *muted = cc->muted ? 1 : 0;
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyChatControlSetAudioInputMuted(PARTY_CHAT_CONTROL_HANDLE cc, PartyBool muted) {
    TRACE_CALL("PartyChatControlSetAudioInputMuted");
    if (!cc) return kErrInvalidArg;
    const_cast<PARTY_CHAT_CONTROL*>(cc)->muted = muted != 0;
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyChatControlGetAudioRenderVolume(PARTY_CHAT_CONTROL_HANDLE cc, PARTY_CHAT_CONTROL_HANDLE target, float* volume) {
    TRACE_CALL("PartyChatControlGetAudioRenderVolume");
    if (!cc || !target || !volume) return kErrInvalidArg;
    *volume = target->volume;
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyChatControlSetAudioRenderVolume(PARTY_CHAT_CONTROL_HANDLE cc, PARTY_CHAT_CONTROL_HANDLE target, float volume) {
    TRACE_CALL("PartyChatControlSetAudioRenderVolume");
    if (!cc || !target) return kErrInvalidArg;
    const_cast<PARTY_CHAT_CONTROL*>(target)->volume = volume;
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyChatControlSetPermissions(PARTY_CHAT_CONTROL_HANDLE cc, PARTY_CHAT_CONTROL_HANDLE target, PARTY_CHAT_PERMISSION_OPTIONS) {
    TRACE_CALL("PartyChatControlSetPermissions");
    return (cc && target) ? c_partyErrorSuccess : kErrInvalidArg;
}
PartyError PARTY_API PartyChatControlGetChatIndicator(PARTY_CHAT_CONTROL_HANDLE cc, PARTY_CHAT_CONTROL_HANDLE target, PARTY_CHAT_CONTROL_CHAT_INDICATOR* ind) {
    TRACE_CALL("PartyChatControlGetChatIndicator");
    if (!cc || !target || !ind) return kErrInvalidArg;
    *ind = (PARTY_CHAT_CONTROL_CHAT_INDICATOR)0;
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyChatControlGetLocalChatIndicator(PARTY_CHAT_CONTROL_HANDLE cc, PARTY_LOCAL_CHAT_CONTROL_CHAT_INDICATOR* ind) {
    TRACE_CALL("PartyChatControlGetLocalChatIndicator");
    if (!cc || !ind) return kErrInvalidArg;
    *ind = (PARTY_LOCAL_CHAT_CONTROL_CHAT_INDICATOR)0;
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyChatControlGetEntityId(PARTY_CHAT_CONTROL_HANDLE cc, PartyString* entityId) {
    TRACE_CALL("PartyChatControlGetEntityId");
    if (!cc || !entityId) return kErrInvalidArg;
    *entityId = cc->entityId.c_str();
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyChatControlIsLocal(PARTY_CHAT_CONTROL_HANDLE cc, PartyBool* isLocal) {
    TRACE_CALL("PartyChatControlIsLocal");
    if (!cc || !isLocal) return kErrInvalidArg;
    *isLocal = cc->local ? 1 : 0;
    return c_partyErrorSuccess;
}

PartyError PARTY_API PartyChatControlConfigureAudioManipulationVoiceStream(PARTY_CHAT_CONTROL_HANDLE cc, PARTY_AUDIO_MANIPULATION_SOURCE_STREAM_CONFIGURATION* cfg, void* async) {
    TRACE_CALL("PartyChatControlConfigureAudioManipulationVoiceStream");
    if (!cc) return kErrInvalidArg;
    std::lock_guard<std::recursive_mutex> l(G.mu);
    SC* sc; auto* a = newSC<PARTY_CONFIGURE_AUDIO_MANIPULATION_VOICE_STREAM_COMPLETED_STATE_CHANGE>(sc, PARTY_STATE_CHANGE_TYPE_CONFIGURE_AUDIO_MANIPULATION_VOICE_STREAM_COMPLETED);
    a->result = PARTY_STATE_CHANGE_RESULT_SUCCEEDED; a->chatControl = cc; a->configuration = cfg; a->asyncIdentifier = async; push(sc);
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyChatControlGetAudioManipulationVoiceStream(PARTY_CHAT_CONTROL_HANDLE cc, PARTY_AUDIO_MANIPULATION_SOURCE_STREAM_HANDLE* stream) {
    TRACE_CALL("PartyChatControlGetAudioManipulationVoiceStream");
    if (!cc || !stream) return kErrInvalidArg;
    *stream = &G.voiceStream;
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyAudioManipulationSourceStreamGetNextBuffer(PARTY_AUDIO_MANIPULATION_SOURCE_STREAM_HANDLE stream, PARTY_MUTABLE_DATA_BUFFER* buffer) {
    TRACE_CALL("PartyAudioManipulationSourceStreamGetNextBuffer");
    if (!stream || !buffer) return kErrInvalidArg;
    buffer->buffer = nullptr; buffer->bufferByteCount = 0;      /* no voice is carried: the stream is always drained */
    return c_partyErrorSuccess;
}
PartyError PARTY_API PartyAudioManipulationSourceStreamReturnBuffer(PARTY_AUDIO_MANIPULATION_SOURCE_STREAM_HANDLE stream, void* buffer) {
    TRACE_CALL("PartyAudioManipulationSourceStreamReturnBuffer");
    (void)buffer;
    return stream ? c_partyErrorSuccess : kErrInvalidArg;
}

/* Every PartyWin export the game does not import points here (see exports.h). */
PartyError PARTY_API PartyShimUnsupported(void) { logf("unsupported Party export called"); return kErrUnsupported; }

} /* extern "C" */

#include "exports.h"
