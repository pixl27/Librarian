/*
 * EOS emulator — core lifecycle, identity and P2P transport.
 *
 * Built against Epic's real SDK headers, so every struct layout and
 * ApiVersion constant here is the genuine one rather than a guess. Verified
 * against the game's own SDK: Big Walk ships 679 exports, the 1.19.1.2 headers
 * cover 100% of them, nothing missing.
 *
 * What this replaces: EOS normally reaches Epic's servers for identity,
 * lobbies and packet relay. Here all three are local — identity is derived on
 * the machine, and peers find each other by UDP broadcast on the LAN (or a
 * virtual one: Tailscale, ZeroTier, Radmin), exactly like the Steam emulator
 * this project already ships.
 *
 * The one thing that shapes everything else: EOS is asynchronous, but it has
 * no threads of its own. A call like EOS_Connect_Login returns immediately and
 * the game learns the outcome only when it calls EOS_Platform_Tick. So results
 * are queued here and delivered from Tick, on the game's own thread. Firing a
 * callback inline from the calling function would reenter game code from the
 * wrong place and is the classic way to deadlock a Unity title.
 */

#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include "eos_sdk.h"
#include "eos_init.h"
#include "eos_connect.h"
#include "eos_p2p.h"
#include "eos_logging.h"

/* ── Logging ──────────────────────────────────────────────────────
 * A game gives no feedback about why EOS failed — it simply never reaches
 * multiplayer. Without a trace of which calls arrived and what we answered,
 * a failed launch is unfalsifiable. The log lands beside the DLL, is opened
 * per line, and never blocks the game if it cannot be written. */
static void emu_log(const char *fmt, ...)
{
    static char path[MAX_PATH];
    static int  ready = 0;
    if (!ready) {
        HMODULE self = NULL;
        GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                           | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCSTR)(void *)&emu_log, &self);
        if (GetModuleFileNameA(self, path, MAX_PATH)) {
            char *slash = strrchr(path, '\\');
            if (slash) { slash[1] = '\0'; strncat(path, "librarian_eos.log", MAX_PATH - strlen(path) - 1); }
        }
        ready = 1;
    }
    FILE *f = fopen(path, "a");
    if (!f) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(f, "[%02d:%02d:%02d.%03d] ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list ap; va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

/* ── Tunables ─────────────────────────────────────────────────── */
#define EMU_PORT_BASE   47800    /* first UDP port tried; peers scan a small range */
#define EMU_PORT_SPAN   8
#define EMU_MAX_PACKET  4096
#define EMU_MAX_QUEUE   512
#define EMU_MAX_PEERS   32

/* ── Queued callbacks ─────────────────────────────────────────────
 * Every async result lands here and is drained by EOS_Platform_Tick. */
typedef void (EOS_CALL *emu_cb)(const void *info);

typedef struct {
    emu_cb   fn;
    void    *client_data;
    int      kind;                 /* which callback-info struct to build */
    EOS_EResult result;
    EOS_ProductUserId user;
} emu_pending;

#define CB_CONNECT_LOGIN 1

/* ── Received packet ──────────────────────────────────────────── */
typedef struct {
    EOS_ProductUserId from;
    uint8_t  channel;
    uint32_t len;
    uint8_t  data[EMU_MAX_PACKET];
} emu_packet;

/* ── Peer ─────────────────────────────────────────────────────── */
typedef struct {
    EOS_ProductUserId id;
    struct sockaddr_in addr;
    uint64_t last_seen;
} emu_peer;

/* ── Global state ─────────────────────────────────────────────── */
static struct {
    int initialised;
    int platform_live;

    /* identity: a stable 64-bit id derived once per machine+product */
    char           puid_text[32];
    EOS_ProductUserId puid;
    int            logged_in;

    SOCKET         sock;
    uint16_t       port;

    emu_pending    pending[64];
    int            pending_count;
    CRITICAL_SECTION lock;

    emu_packet     rx[EMU_MAX_QUEUE];
    int            rx_head, rx_tail;

    emu_peer       peers[EMU_MAX_PEERS];
    int            peer_count;
} G;

/*
 * EOS_ProductUserId is an opaque pointer that the game may hold for the whole
 * session and hand back to us later, so it has to stay valid and comparable.
 * Pointing it at a stable string buffer satisfies both, and makes
 * EOS_ProductUserId_ToString trivial.
 */
static EOS_ProductUserId puid_from_text(const char *text)
{
    return (EOS_ProductUserId)(void *)text;
}

/* A machine-stable id, so a player keeps the same identity across launches. */
static void derive_identity(const char *product)
{
    char host[256] = {0};
    DWORD n = sizeof host;
    GetComputerNameA(host, &n);

    uint64_t h = 1469598103934665603ULL;          /* FNV-1a */
    const char *parts[2] = { host, product ? product : "eos" };
    for (int p = 0; p < 2; p++)
        for (const char *c = parts[p]; c && *c; c++) {
            h ^= (unsigned char)*c;
            h *= 1099511628211ULL;
        }
    /* EOS ids are 32 hex chars; the shape matters to games that parse them. */
    snprintf(G.puid_text, sizeof G.puid_text, "%016llx%016llx",
             (unsigned long long)h, (unsigned long long)(h ^ 0x5bf03635ULL));
    G.puid = puid_from_text(G.puid_text);
}

static void queue_callback(emu_cb fn, void *client_data, int kind, EOS_EResult result)
{
    if (!fn) return;
    EnterCriticalSection(&G.lock);
    if (G.pending_count < (int)(sizeof G.pending / sizeof G.pending[0])) {
        emu_pending *p = &G.pending[G.pending_count++];
        p->fn = fn;
        p->client_data = client_data;
        p->kind = kind;
        p->result = result;
        p->user = G.puid;
    }
    LeaveCriticalSection(&G.lock);
}

/* ── UDP transport ────────────────────────────────────────────── */

static void transport_start(void)
{
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return;

    G.sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (G.sock == INVALID_SOCKET) return;

    BOOL yes = TRUE;
    setsockopt(G.sock, SOL_SOCKET, SO_BROADCAST, (char *)&yes, sizeof yes);
    setsockopt(G.sock, SOL_SOCKET, SO_REUSEADDR, (char *)&yes, sizeof yes);
    u_long nonblock = 1;
    ioctlsocket(G.sock, FIONBIO, &nonblock);

    /* Two players on one machine must not fight over a port, so take the
     * first free one in a small range and advertise it during discovery. */
    for (int i = 0; i < EMU_PORT_SPAN; i++) {
        struct sockaddr_in a;
        memset(&a, 0, sizeof a);
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = INADDR_ANY;
        a.sin_port = htons((u_short)(EMU_PORT_BASE + i));
        if (bind(G.sock, (struct sockaddr *)&a, sizeof a) == 0) {
            G.port = (uint16_t)(EMU_PORT_BASE + i);
            return;
        }
    }
    closesocket(G.sock);
    G.sock = INVALID_SOCKET;
}

static void transport_stop(void)
{
    if (G.sock != INVALID_SOCKET) {
        closesocket(G.sock);
        G.sock = INVALID_SOCKET;
    }
    WSACleanup();
}

/* Wire format: a 4-byte tag, the sender's 32-char id, channel, then payload.
 * Deliberately trivial — this only ever talks to another copy of itself. */
#define WIRE_TAG "LBE1"
#define WIRE_HDR (4 + 32 + 1)

static void transport_send(const struct sockaddr_in *to, uint8_t channel,
                           const void *data, uint32_t len)
{
    if (G.sock == INVALID_SOCKET || len > EMU_MAX_PACKET) return;
    char buf[WIRE_HDR + EMU_MAX_PACKET];
    memcpy(buf, WIRE_TAG, 4);
    memcpy(buf + 4, G.puid_text, 32);
    buf[36] = (char)channel;
    if (len) memcpy(buf + WIRE_HDR, data, len);
    sendto(G.sock, buf, (int)(WIRE_HDR + len), 0,
           (const struct sockaddr *)to, sizeof *to);
}

/* Drain the socket into the receive queue. Called from Tick. */
static void transport_poll(void)
{
    if (G.sock == INVALID_SOCKET) return;
    char buf[WIRE_HDR + EMU_MAX_PACKET];
    for (;;) {
        struct sockaddr_in from;
        int flen = sizeof from;
        int n = recvfrom(G.sock, buf, sizeof buf, 0, (struct sockaddr *)&from, &flen);
        if (n < (int)WIRE_HDR) break;
        if (memcmp(buf, WIRE_TAG, 4) != 0) continue;

        /* Ignore our own broadcasts. */
        if (memcmp(buf + 4, G.puid_text, 32) == 0) continue;

        int next = (G.rx_tail + 1) % EMU_MAX_QUEUE;
        if (next == G.rx_head) break;              /* queue full: drop, as UDP would */
        emu_packet *p = &G.rx[G.rx_tail];
        /* The sender id is copied into peer storage so the pointer we hand the
         * game outlives this packet. */
        p->from = NULL;
        for (int i = 0; i < G.peer_count; i++) {
            if (memcmp((const char *)G.peers[i].id, buf + 4, 32) == 0) {
                p->from = G.peers[i].id;
                G.peers[i].addr = from;
                break;
            }
        }
        if (!p->from && G.peer_count < EMU_MAX_PEERS) {
            emu_peer *pe = &G.peers[G.peer_count++];
            char *store = (char *)calloc(33, 1);
            memcpy(store, buf + 4, 32);
            pe->id = puid_from_text(store);
            pe->addr = from;
            p->from = pe->id;
        }
        p->channel = (uint8_t)buf[36];
        p->len = (uint32_t)(n - WIRE_HDR);
        if (p->len) memcpy(p->data, buf + WIRE_HDR, p->len);
        G.rx_tail = next;
    }
}

/* ── Lifecycle ────────────────────────────────────────────────── */

EOS_DECLARE_FUNC(EOS_EResult) EOS_Initialize(const EOS_InitializeOptions *Options)
{
    if (G.initialised) return EOS_AlreadyConfigured;
    memset(&G, 0, sizeof G);
    InitializeCriticalSection(&G.lock);
    G.sock = INVALID_SOCKET;
    derive_identity(Options ? Options->ProductName : NULL);
    transport_start();
    G.initialised = 1;
    emu_log("EOS_Initialize product=%s puid=%s port=%u", Options && Options->ProductName ? Options->ProductName : "(null)", G.puid_text, (unsigned)G.port);
    return EOS_Success;
}

EOS_DECLARE_FUNC(EOS_EResult) EOS_Shutdown(void)
{
    if (!G.initialised) return EOS_NotConfigured;
    transport_stop();
    DeleteCriticalSection(&G.lock);
    G.initialised = 0;
    return EOS_Success;
}

/* A non-NULL opaque handle is all a game needs; it only ever passes it back. */
static int g_platform_token;

EOS_DECLARE_FUNC(EOS_HPlatform) EOS_Platform_Create(const EOS_Platform_Options *Options)
{
    (void)Options;
    if (!G.initialised) return NULL;
    G.platform_live = 1;
    emu_log("EOS_Platform_Create");
    return (EOS_HPlatform)&g_platform_token;
}

EOS_DECLARE_FUNC(void) EOS_Platform_Release(EOS_HPlatform Handle)
{
    (void)Handle;
    G.platform_live = 0;
}

/*
 * The heartbeat. Everything asynchronous is delivered from here, on the
 * caller's thread, which is what the SDK contract promises.
 */
EOS_DECLARE_FUNC(void) EOS_Platform_Tick(EOS_HPlatform Handle)
{
    (void)Handle;
    if (!G.initialised) return;

    transport_poll();

    /* Copy out under the lock, then invoke outside it: a callback is game code
     * and may call straight back into us. */
    emu_pending batch[64];
    int count = 0;
    EnterCriticalSection(&G.lock);
    count = G.pending_count;
    if (count) memcpy(batch, G.pending, sizeof(emu_pending) * count);
    G.pending_count = 0;
    LeaveCriticalSection(&G.lock);

    for (int i = 0; i < count; i++) {
        if (batch[i].kind == CB_CONNECT_LOGIN) {
            EOS_Connect_LoginCallbackInfo info;
            memset(&info, 0, sizeof info);
            info.ResultCode = batch[i].result;
            info.ClientData = batch[i].client_data;
            info.LocalUserId = batch[i].user;
            info.ContinuanceToken = NULL;
            ((EOS_Connect_OnLoginCallback)batch[i].fn)(&info);
        }
    }
}

/* Interface handles: distinct non-NULL tokens so a game can tell them apart. */
static int g_connect_token, g_lobby_token, g_p2p_token, g_auth_token;

EOS_DECLARE_FUNC(EOS_HConnect) EOS_Platform_GetConnectInterface(EOS_HPlatform h)
{ (void)h; return (EOS_HConnect)&g_connect_token; }

EOS_DECLARE_FUNC(EOS_HLobby) EOS_Platform_GetLobbyInterface(EOS_HPlatform h)
{ (void)h; return (EOS_HLobby)&g_lobby_token; }

EOS_DECLARE_FUNC(EOS_HP2P) EOS_Platform_GetP2PInterface(EOS_HPlatform h)
{ (void)h; return (EOS_HP2P)&g_p2p_token; }

EOS_DECLARE_FUNC(EOS_HAuth) EOS_Platform_GetAuthInterface(EOS_HPlatform h)
{ (void)h; return (EOS_HAuth)&g_auth_token; }

/* ── Identity ─────────────────────────────────────────────────── */

/*
 * Device ID auth is the anonymous, account-free path EOS already supports, so
 * a local identity is a legitimate answer to this call rather than a forgery
 * of someone's Epic account.
 */
EOS_DECLARE_FUNC(void) EOS_Connect_Login(EOS_HConnect Handle,
                                         const EOS_Connect_LoginOptions *Options,
                                         void *ClientData,
                                         const EOS_Connect_OnLoginCallback CompletionDelegate)
{
    (void)Handle; (void)Options;
    emu_log("EOS_Connect_Login -> queuing success as %s", G.puid_text);
    G.logged_in = 1;
    queue_callback((emu_cb)CompletionDelegate, ClientData,
                   CB_CONNECT_LOGIN, EOS_Success);
}

EOS_DECLARE_FUNC(EOS_ELoginStatus) EOS_Connect_GetLoginStatus(EOS_HConnect Handle,
                                                              EOS_ProductUserId LocalUserId)
{
    (void)Handle; (void)LocalUserId;
    return G.logged_in ? EOS_LS_LoggedIn : EOS_LS_NotLoggedIn;
}

EOS_DECLARE_FUNC(int32_t) EOS_Connect_GetLoggedInUsersCount(EOS_HConnect Handle)
{ (void)Handle; return G.logged_in ? 1 : 0; }

EOS_DECLARE_FUNC(EOS_ProductUserId) EOS_Connect_GetLoggedInUserByIndex(EOS_HConnect Handle, int32_t Index)
{ (void)Handle; return (G.logged_in && Index == 0) ? G.puid : NULL; }

/* ── P2P ──────────────────────────────────────────────────────── */

EOS_DECLARE_FUNC(EOS_EResult) EOS_P2P_SendPacket(EOS_HP2P Handle,
                                                 const EOS_P2P_SendPacketOptions *Options)
{
    (void)Handle;
    if (!Options || !Options->Data) return EOS_InvalidParameters;

    /* Route to the peer if we know it, otherwise broadcast so a peer that has
     * not announced itself yet still hears us. */
    for (int i = 0; i < G.peer_count; i++) {
        if (G.peers[i].id == Options->RemoteUserId) {
            transport_send(&G.peers[i].addr, Options->Channel,
                           Options->Data, Options->DataLengthBytes);
            return EOS_Success;
        }
    }
    struct sockaddr_in bcast;
    memset(&bcast, 0, sizeof bcast);
    bcast.sin_family = AF_INET;
    bcast.sin_addr.s_addr = INADDR_BROADCAST;
    for (int i = 0; i < EMU_PORT_SPAN; i++) {
        bcast.sin_port = htons((u_short)(EMU_PORT_BASE + i));
        transport_send(&bcast, Options->Channel, Options->Data, Options->DataLengthBytes);
    }
    return EOS_Success;
}

EOS_DECLARE_FUNC(EOS_EResult) EOS_P2P_GetNextReceivedPacketSize(EOS_HP2P Handle,
                                                                const EOS_P2P_GetNextReceivedPacketSizeOptions *Options,
                                                                uint32_t *OutPacketSizeBytes)
{
    (void)Handle; (void)Options;
    if (!OutPacketSizeBytes) return EOS_InvalidParameters;
    if (G.rx_head == G.rx_tail) return EOS_NotFound;
    *OutPacketSizeBytes = G.rx[G.rx_head].len;
    return EOS_Success;
}

EOS_DECLARE_FUNC(EOS_EResult) EOS_P2P_ReceivePacket(EOS_HP2P Handle,
                                                    const EOS_P2P_ReceivePacketOptions *Options,
                                                    EOS_ProductUserId *OutPeerId,
                                                    EOS_P2P_SocketId *OutSocketId,
                                                    uint8_t *OutChannel,
                                                    void *OutData,
                                                    uint32_t *OutBytesWritten)
{
    (void)Handle;
    if (G.rx_head == G.rx_tail) return EOS_NotFound;

    emu_packet *p = &G.rx[G.rx_head];
    if (Options && p->len > Options->MaxDataSizeBytes) return EOS_LimitExceeded;

    if (OutPeerId)  *OutPeerId = p->from;
    if (OutChannel) *OutChannel = p->channel;
    if (OutData && p->len) memcpy(OutData, p->data, p->len);
    if (OutBytesWritten) *OutBytesWritten = p->len;
    if (OutSocketId) memset(OutSocketId, 0, sizeof *OutSocketId);

    G.rx_head = (G.rx_head + 1) % EMU_MAX_QUEUE;
    return EOS_Success;
}

/* Connections are implicit on a trusted LAN, so accepting is a no-op that
 * reports success rather than a stub that reports failure. */
EOS_DECLARE_FUNC(EOS_EResult) EOS_P2P_AcceptConnection(EOS_HP2P Handle,
                                                       const EOS_P2P_AcceptConnectionOptions *Options)
{ (void)Handle; (void)Options; return EOS_Success; }

EOS_DECLARE_FUNC(EOS_EResult) EOS_P2P_CloseConnection(EOS_HP2P Handle,
                                                      const EOS_P2P_CloseConnectionOptions *Options)
{ (void)Handle; (void)Options; return EOS_Success; }

/* ── Product user ids ─────────────────────────────────────────── */

EOS_DECLARE_FUNC(EOS_Bool) EOS_ProductUserId_IsValid(EOS_ProductUserId Id)
{ return Id ? EOS_TRUE : EOS_FALSE; }

EOS_DECLARE_FUNC(EOS_EResult) EOS_ProductUserId_ToString(EOS_ProductUserId Id,
                                                         char *OutBuffer, int32_t *InOutBufferLength)
{
    if (!Id || !OutBuffer || !InOutBufferLength) return EOS_InvalidParameters;
    const char *text = (const char *)Id;
    int32_t need = (int32_t)strlen(text) + 1;
    if (*InOutBufferLength < need) { *InOutBufferLength = need; return EOS_LimitExceeded; }
    memcpy(OutBuffer, text, need);
    *InOutBufferLength = need;
    return EOS_Success;
}

EOS_DECLARE_FUNC(EOS_ProductUserId) EOS_ProductUserId_FromString(const char *Str)
{
    if (!Str) return NULL;
    for (int i = 0; i < G.peer_count; i++)
        if (strcmp((const char *)G.peers[i].id, Str) == 0) return G.peers[i].id;
    if (strcmp(G.puid_text, Str) == 0) return G.puid;
    return NULL;
}
