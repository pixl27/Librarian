/*
 * A small game written against the real PlayFab Party C API (Party_c.h), used to
 * prove the PartyWin.dll replacement behaves the way a title expects. It is
 * deliberately shaped like Microsoft's own sample: create or join a network,
 * authenticate, create an endpoint, then trade messages.
 *
 *   party_client host                 create a network, print DESCRIPTOR, wait for a peer
 *   party_client join <descriptor>    join a network published by a host
 *
 * Output is line-oriented so party-shim.test.cjs can assert on it.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include <vector>
#include "Party_c.h"

static const char* typeName(uint32_t t) {
    switch (t) {
    case PARTY_STATE_CHANGE_TYPE_CREATE_NEW_NETWORK_COMPLETED: return "CreateNewNetworkCompleted";
    case PARTY_STATE_CHANGE_TYPE_CONNECT_TO_NETWORK_COMPLETED: return "ConnectToNetworkCompleted";
    case PARTY_STATE_CHANGE_TYPE_AUTHENTICATE_LOCAL_USER_COMPLETED: return "AuthenticateLocalUserCompleted";
    case PARTY_STATE_CHANGE_TYPE_NETWORK_CONFIGURATION_MADE_AVAILABLE: return "NetworkConfigurationMadeAvailable";
    case PARTY_STATE_CHANGE_TYPE_CREATE_ENDPOINT_COMPLETED: return "CreateEndpointCompleted";
    case PARTY_STATE_CHANGE_TYPE_ENDPOINT_CREATED: return "EndpointCreated";
    case PARTY_STATE_CHANGE_TYPE_ENDPOINT_DESTROYED: return "EndpointDestroyed";
    case PARTY_STATE_CHANGE_TYPE_REMOTE_DEVICE_CREATED: return "RemoteDeviceCreated";
    case PARTY_STATE_CHANGE_TYPE_REMOTE_DEVICE_JOINED_NETWORK: return "RemoteDeviceJoinedNetwork";
    case PARTY_STATE_CHANGE_TYPE_REMOTE_DEVICE_LEFT_NETWORK: return "RemoteDeviceLeftNetwork";
    case PARTY_STATE_CHANGE_TYPE_REMOTE_DEVICE_DESTROYED: return "RemoteDeviceDestroyed";
    case PARTY_STATE_CHANGE_TYPE_ENDPOINT_MESSAGE_RECEIVED: return "EndpointMessageReceived";
    case PARTY_STATE_CHANGE_TYPE_DATA_BUFFERS_RETURNED: return "DataBuffersReturned";
    case PARTY_STATE_CHANGE_TYPE_LEAVE_NETWORK_COMPLETED: return "LeaveNetworkCompleted";
    case PARTY_STATE_CHANGE_TYPE_NETWORK_DESTROYED: return "NetworkDestroyed";
    case PARTY_STATE_CHANGE_TYPE_CREATE_CHAT_CONTROL_COMPLETED: return "CreateChatControlCompleted";
    case PARTY_STATE_CHANGE_TYPE_CHAT_CONTROL_CREATED: return "ChatControlCreated";
    case PARTY_STATE_CHANGE_TYPE_CONNECT_CHAT_CONTROL_COMPLETED: return "ConnectChatControlCompleted";
    case PARTY_STATE_CHANGE_TYPE_CHAT_CONTROL_JOINED_NETWORK: return "ChatControlJoinedNetwork";
    case PARTY_STATE_CHANGE_TYPE_SET_CHAT_AUDIO_INPUT_COMPLETED: return "SetChatAudioInputCompleted";
    case PARTY_STATE_CHANGE_TYPE_SET_CHAT_AUDIO_OUTPUT_COMPLETED: return "SetChatAudioOutputCompleted";
    case PARTY_STATE_CHANGE_TYPE_LOCAL_CHAT_AUDIO_INPUT_CHANGED: return "LocalChatAudioInputChanged";
    case PARTY_STATE_CHANGE_TYPE_LOCAL_CHAT_AUDIO_OUTPUT_CHANGED: return "LocalChatAudioOutputChanged";
    default: return "Other";
    }
}

#define CHECK(call) do { PartyError e_ = (call); if (e_ != c_partyErrorSuccess) { printf("FAIL %s -> 0x%x\n", #call, e_); fflush(stdout); return 2; } } while (0)

int main(int argc, char** argv) {
    if (argc < 2) return 64;
    const bool host = strcmp(argv[1], "host") == 0;
    const char* self = host ? "ENTITY-HOST" : "ENTITY-JOIN";
    const char* peerHello = host ? "hello-from-join" : "hello-from-host";

    PARTY_HANDLE party = nullptr;
    CHECK(PartyInitialize("TESTTITLE", &party));
    PARTY_LOCAL_USER_HANDLE user = nullptr;
    CHECK(PartyCreateLocalUser(party, self, "token", &user));

    PARTY_DEVICE_HANDLE dev = nullptr;
    CHECK(PartyGetLocalDevice(party, &dev));
    PARTY_CHAT_CONTROL_HANDLE chat = nullptr;
    CHECK(PartyDeviceCreateChatControl(dev, user, "en-US", nullptr, &chat));
    CHECK(PartyChatControlSetAudioInput(chat, PARTY_AUDIO_DEVICE_SELECTION_TYPE_SYSTEM_DEFAULT, nullptr, nullptr));
    CHECK(PartyChatControlSetAudioOutput(chat, PARTY_AUDIO_DEVICE_SELECTION_TYPE_SYSTEM_DEFAULT, nullptr, nullptr));

    PARTY_NETWORK_DESCRIPTOR desc = {};
    if (host) {
        PARTY_NETWORK_CONFIGURATION cfg = {};
        cfg.maxUserCount = 4; cfg.maxDeviceCount = 4; cfg.maxUsersPerDeviceCount = 1; cfg.maxDevicesPerUserCount = 1; cfg.maxEndpointsPerDeviceCount = 1;
        PARTY_INVITATION_CONFIGURATION inv = { "invite-1", PARTY_INVITATION_REVOCABILITY_ANYONE, 0, nullptr };
        CHECK(PartyCreateNewNetwork(party, user, &cfg, 0, nullptr, &inv, nullptr, &desc, nullptr));
        char text[PARTY_MAX_SERIALIZED_NETWORK_DESCRIPTOR_STRING_LENGTH + 1] = {};
        CHECK(PartySerializeNetworkDescriptor(&desc, text));
        printf("DESCRIPTOR %s\n", text);
        fflush(stdout);
    } else {
        if (argc < 3) return 64;
        CHECK(PartyDeserializeNetworkDescriptor(argv[2], &desc));
    }

    PARTY_NETWORK_HANDLE net = nullptr;
    CHECK(PartyConnectToNetwork(party, &desc, nullptr, &net));
    CHECK(PartyNetworkAuthenticateLocalUser(net, user, "invite-1", nullptr));
    CHECK(PartyNetworkConnectChatControl(net, chat, nullptr));
    PARTY_ENDPOINT_HANDLE local = nullptr;
    CHECK(PartyNetworkCreateEndpoint(net, user, 0, nullptr, nullptr, nullptr, &local));

    bool sentHello = false, done = false, left = false;
    static char dontCopy[] = "-payload";
    DWORD start = GetTickCount();
    while (GetTickCount() - start < 20000) {
        uint32_t count = 0;
        const PARTY_STATE_CHANGE* const* changes = nullptr;
        CHECK(PartyStartProcessingStateChanges(party, &count, &changes));
        for (uint32_t i = 0; i < count; i++) {
            const PARTY_STATE_CHANGE* sc = changes[i];
            const char* name = typeName(sc->stateChangeType);
            switch (sc->stateChangeType) {
            case PARTY_STATE_CHANGE_TYPE_CONNECT_TO_NETWORK_COMPLETED: {
                auto* c = (const PARTY_CONNECT_TO_NETWORK_COMPLETED_STATE_CHANGE*)sc;
                printf("EV %s result=%d\n", name, (int)c->result);
                if (c->result != PARTY_STATE_CHANGE_RESULT_SUCCEEDED) { fflush(stdout); return 3; }
                break;
            }
            case PARTY_STATE_CHANGE_TYPE_ENDPOINT_CREATED: {
                auto* c = (const PARTY_ENDPOINT_CREATED_STATE_CHANGE*)sc;
                PartyBool isLocal = 0; PartyEndpointIsLocal(c->endpoint, &isLocal);
                PartyString entity = nullptr; PartyEndpointGetEntityId(c->endpoint, &entity);
                printf("EV %s local=%d entity=%s\n", name, (int)isLocal, entity ? entity : "(null)");
                if (!isLocal && !sentHello) {
                    // Three buffers, so the receiver only sees the right bytes if they are concatenated in order.
                    const char* a = host ? "hello-" : "hello-";
                    const char* b = host ? "from-" : "from-";
                    const char* c3 = host ? "host" : "join";
                    PARTY_DATA_BUFFER bufs[3] = { { a, 6 }, { b, 5 }, { c3, 4 } };
                    PARTY_ENDPOINT_HANDLE target = c->endpoint;
                    CHECK(PartyEndpointSendMessage(local, 1, &target,
                        (PARTY_SEND_MESSAGE_OPTIONS)(PARTY_SEND_MESSAGE_OPTIONS_GUARANTEED_DELIVERY | PARTY_SEND_MESSAGE_OPTIONS_SEQUENTIAL_DELIVERY),
                        nullptr, 3, bufs, nullptr));
                    sentHello = true;
                }
                break;
            }
            case PARTY_STATE_CHANGE_TYPE_ENDPOINT_MESSAGE_RECEIVED: {
                auto* c = (const PARTY_ENDPOINT_MESSAGE_RECEIVED_STATE_CHANGE*)sc;
                std::string body((const char*)c->messageBuffer, c->messageSize);
                PartyString from = nullptr; PartyEndpointGetEntityId(c->senderEndpoint, &from);
                printf("GOT %s from=%s receivers=%u options=%d\n", body.c_str(), from ? from : "(null)", c->receiverEndpointCount, (int)c->options);
                if (body == peerHello && !host) {
                    // Reply with DONT_COPY so the shim has to hand the buffer back through DataBuffersReturned.
                    PARTY_DATA_BUFFER bufs[2] = { { "bye", 3 }, { dontCopy, 0 } };
                    PARTY_ENDPOINT_HANDLE target = c->senderEndpoint;
                    CHECK(PartyEndpointSendMessage(local, 1, &target,
                        (PARTY_SEND_MESSAGE_OPTIONS)(PARTY_SEND_MESSAGE_OPTIONS_GUARANTEED_DELIVERY | PARTY_SEND_MESSAGE_OPTIONS_DONT_COPY_DATA_BUFFERS),
                        nullptr, 2, bufs, (void*)0x1234));
                } else if (body == "bye" && host) {
                    done = true;
                }
                break;
            }
            case PARTY_STATE_CHANGE_TYPE_DATA_BUFFERS_RETURNED: {
                auto* c = (const PARTY_DATA_BUFFERS_RETURNED_STATE_CHANGE*)sc;
                printf("EV %s count=%u id=%p\n", name, c->dataBufferCount, c->messageIdentifier);
                if (!host) done = true;
                break;
            }
            case PARTY_STATE_CHANGE_TYPE_ENDPOINT_DESTROYED: {
                auto* c = (const PARTY_ENDPOINT_DESTROYED_STATE_CHANGE*)sc;
                PartyBool isLocal = 0; PartyEndpointIsLocal(c->endpoint, &isLocal);
                printf("EV %s local=%d reason=%d\n", name, (int)isLocal, (int)c->reason);
                if (host && !isLocal && left) done = true;
                break;
            }
            case PARTY_STATE_CHANGE_TYPE_NETWORK_DESTROYED:
                printf("EV %s reason=%d\n", name, (int)((const PARTY_NETWORK_DESTROYED_STATE_CHANGE*)sc)->reason);
                fflush(stdout);
                PartyFinishProcessingStateChanges(party, count, changes);
                PartyCleanup(party);
                printf("EXIT clean\n");
                return 0;
            default:
                printf("EV %s\n", name);
            }
        }
        fflush(stdout);
        CHECK(PartyFinishProcessingStateChanges(party, count, changes));

        if (done && !left) {
            if (host) printf("DONE host saw bye\n"); else printf("DONE join saw returned buffers\n");
            fflush(stdout);
            // Give the outgoing "bye" a moment to leave the socket before we close it.
            Sleep(300);
            CHECK(PartyNetworkLeaveNetwork(net, nullptr));
            left = true;
        }
        Sleep(10);
    }
    printf("FAIL timeout\n");
    return 4;
}
