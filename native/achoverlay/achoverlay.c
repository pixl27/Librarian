/*
 * In-game achievement overlay — Direct3D 11.
 *
 * A window cannot be shown over a game that has taken the display exclusively:
 * that game owns the flip chain and the desktop compositor is out of the
 * picture, which is why Steam's own overlay injects itself rather than opening
 * a window. This does the same thing, and draws Librarian's toast inside the
 * game's own frame.
 *
 * How it gets in: the launcher loads it from outside with librarian_inject
 * (inject.c) right after the game process exists — for a Goldberg title
 * steam_api64.dll *is* the emulator, so nothing of ours is in the process to
 * do it from within. DllMain starts a thread and returns; the thread waits for
 * Librarian to publish something to draw or to tune, then hooks.
 *
 * How it hooks: IDXGISwapChain's vtable lives in dxgi.dll and is shared by
 * every swap chain in the process, so a dummy chain created here yields the
 * same function pointers the game's chain uses. Patching entry 8 (Present) and
 * entry 22 (Present1, which flip-model games call instead) is therefore
 * enough, and needs no trampoline — the original pointer is kept and called
 * directly. Inline hooking would be more invasive for no gain.
 *
 * What it draws: whatever Librarian put in the shared section. See shared.h
 * for why the composition happens over there and not here.
 *
 * What else rides the hook: tuning.c — the render-queue cap, the frame
 * limiter and the per-frame measurements Librarian's Tuning page shows. It is
 * called on either side of the original Present and is inert unless the
 * launcher wrote a config file for this process (see tuning_shared.h).
 *
 * The rule that governs everything below: the game's rendering must come out
 * unchanged. Every piece of pipeline state this touches is saved before and
 * restored after, and any failure at any point disables the overlay for the
 * rest of the session rather than retrying into a broken device.
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "shared.h"
#include "tuning.h"

/* Steam can retain our vtable hook while replacing the address we retained,
 * creating Steam -> Librarian -> Steam recursion. Do not combine these two
 * render hooks. Check intent as well as loaded modules: our winmm/Steam proxy
 * starts the Steam overlay asynchronously, so module presence alone races it.
 * This is independent of the game, Unity version, and Steam export layout. */
static int steam_overlay_requested(void)
{
    if (GetModuleHandleA("GameOverlayRenderer64.dll") ||
        GetModuleHandleA("GameOverlayRenderer.dll")) return 1;

    char path[MAX_PATH];
    if (!GetModuleFileNameA(NULL, path, sizeof path)) return 0;
    char *slash = strrchr(path, '\\');
    if (!slash) return 0;
    slash[1] = '\0';
    if (strlen(path) + strlen("librarian_online.ini") >= sizeof path) return 0;
    strcat(path, "librarian_online.ini");
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    char line[256];
    int enabled = 0;
    while (fgets(line, sizeof line, f)) {
        /* Same flat ini and value semantics as native/overlay/overlay.c. */
        if (!strncmp(line, "steam_overlay=", 14)) { enabled = line[14] == '1'; break; }
    }
    fclose(f);
    return enabled;
}

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")

/* ── Logging ──────────────────────────────────────────────────────
 * Beside the game's executable, like the other native pieces. Silent on
 * success; a game that works must not pay for diagnostics it never reads. */
static void ov_log(const char *fmt, ...)
{
    char path[MAX_PATH];
    if (!GetModuleFileNameA(NULL, path, MAX_PATH)) return;
    char *slash = strrchr(path, '\\');
    if (!slash) return;
    slash[1] = '\0';
    strncat(path, "librarian_achoverlay.log", MAX_PATH - strlen(path) - 1);

    FILE *f = fopen(path, "a");
    if (!f) return;
    va_list args;
    va_start(args, fmt);
    vfprintf(f, fmt, args);
    va_end(args);
    fputc('\n', f);
    fclose(f);
}

/* ── Shared section ───────────────────────────────────────────────*/
static HANDLE                  g_map = NULL;
static librarian_ach_shared_t *g_shared = NULL;

static HANDLE g_file = INVALID_HANDLE_VALUE;

static int open_shared(void)
{
    /*
     * Backed by a file rather than a bare named section, because the writer is
     * Node: it has no way to call CreateFileMapping, but it can write a file.
     * Windows keeps a mapped view and ordinary writes to the same file
     * coherent through one page cache, so the launcher writes with fs.write
     * and this side still sees the bytes without any I/O of its own.
     *
     * Named per process id so two games running at once never share a buffer.
     */
    const char *local = getenv("LOCALAPPDATA");
    if (!local) return 0;

    char path[MAX_PATH];
    if (_snprintf(path, sizeof path, "%s\\Librarian\\overlay\\%lu.bin",
                  local, GetCurrentProcessId()) < 0) return 0;

    HANDLE file = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return 0;   /* launcher has not published one */

    HANDLE map = CreateFileMappingA(file, NULL, PAGE_READONLY, 0,
                                    sizeof(librarian_ach_shared_t), NULL);
    if (!map) { CloseHandle(file); return 0; }

    librarian_ach_shared_t *shared = (librarian_ach_shared_t *)MapViewOfFile(
        map, FILE_MAP_READ, 0, 0, sizeof(librarian_ach_shared_t));
    if (!shared) { CloseHandle(map); CloseHandle(file); return 0; }

    if (shared->magic != LIBRARIAN_ACH_MAGIC || shared->version != LIBRARIAN_ACH_VERSION) {
        ov_log("[achoverlay] shared section has magic %08X version %u; expected %08X/%u",
               shared->magic, shared->version, LIBRARIAN_ACH_MAGIC, LIBRARIAN_ACH_VERSION);
        UnmapViewOfFile(shared); CloseHandle(map); CloseHandle(file);
        return 0;
    }

    /* Published last, and only once valid: the hook may already be live (the
     * tuning half installs it without waiting for this section), and it reads
     * g_shared on the render thread. */
    g_file = file;
    g_map = map;
    MemoryBarrier();
    g_shared = shared;
    return 1;
}

/* ── Renderer ─────────────────────────────────────────────────────*/
typedef HRESULT (STDMETHODCALLTYPE *present_fn)(IDXGISwapChain *, UINT, UINT);
static present_fn g_present_original = NULL;

static int g_disabled = 0;          /* one failure and we stay out of the way */

static ID3D11Device        *g_device = NULL;
static ID3D11DeviceContext *g_context = NULL;
static ID3D11VertexShader  *g_vs = NULL;
static ID3D11PixelShader   *g_ps = NULL;
static ID3D11InputLayout   *g_layout = NULL;
static ID3D11Buffer        *g_vbuf = NULL;
static ID3D11SamplerState  *g_sampler = NULL;
static ID3D11BlendState    *g_blend = NULL;
static ID3D11RasterizerState *g_raster = NULL;
static ID3D11DepthStencilState *g_depth = NULL;
static ID3D11Texture2D     *g_texture = NULL;
static ID3D11ShaderResourceView *g_srv = NULL;
static uint32_t             g_texture_seq = 0xFFFFFFFFU;

typedef struct { float x, y, u, v; } vertex_t;

/* Positions are written straight in clip space, so no transform is needed and
 * the shader is as small as a shader can be. */
static const char *SHADER_SRC =
    "struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };\n"
    "VSOut VSMain(float2 pos : POSITION, float2 uv : TEXCOORD0) {\n"
    "  VSOut o; o.pos = float4(pos, 0.0f, 1.0f); o.uv = uv; return o;\n"
    "}\n"
    "Texture2D tex : register(t0);\n"
    "SamplerState smp : register(s0);\n"
    "float4 PSMain(VSOut i) : SV_TARGET { return tex.Sample(smp, i.uv); }\n";

static void release_resources(void)
{
    if (g_srv)     { ID3D11ShaderResourceView_Release(g_srv); g_srv = NULL; }
    if (g_texture) { ID3D11Texture2D_Release(g_texture); g_texture = NULL; }
    if (g_depth)   { ID3D11DepthStencilState_Release(g_depth); g_depth = NULL; }
    if (g_raster)  { ID3D11RasterizerState_Release(g_raster); g_raster = NULL; }
    if (g_blend)   { ID3D11BlendState_Release(g_blend); g_blend = NULL; }
    if (g_sampler) { ID3D11SamplerState_Release(g_sampler); g_sampler = NULL; }
    if (g_vbuf)    { ID3D11Buffer_Release(g_vbuf); g_vbuf = NULL; }
    if (g_layout)  { ID3D11InputLayout_Release(g_layout); g_layout = NULL; }
    if (g_ps)      { ID3D11PixelShader_Release(g_ps); g_ps = NULL; }
    if (g_vs)      { ID3D11VertexShader_Release(g_vs); g_vs = NULL; }
    if (g_context) { ID3D11DeviceContext_Release(g_context); g_context = NULL; }
    if (g_device)  { ID3D11Device_Release(g_device); g_device = NULL; }
    g_texture_seq = 0xFFFFFFFFU;
}

static int build_resources(IDXGISwapChain *chain)
{
    HRESULT hr = IDXGISwapChain_GetDevice(chain, &IID_ID3D11Device, (void **)&g_device);
    if (FAILED(hr) || !g_device) { ov_log("[achoverlay] not a D3D11 chain (0x%08lX)", hr); return 0; }
    ID3D11Device_GetImmediateContext(g_device, &g_context);
    if (!g_context) return 0;

    ID3DBlob *vsb = NULL, *psb = NULL, *err = NULL;
    hr = D3DCompile(SHADER_SRC, strlen(SHADER_SRC), NULL, NULL, NULL, "VSMain", "vs_4_0", 0, 0, &vsb, &err);
    if (FAILED(hr)) { ov_log("[achoverlay] vs compile 0x%08lX %s", hr, err ? (char *)ID3D10Blob_GetBufferPointer(err) : ""); goto fail; }
    hr = D3DCompile(SHADER_SRC, strlen(SHADER_SRC), NULL, NULL, NULL, "PSMain", "ps_4_0", 0, 0, &psb, &err);
    if (FAILED(hr)) { ov_log("[achoverlay] ps compile 0x%08lX", hr); goto fail; }

    hr = ID3D11Device_CreateVertexShader(g_device, ID3D10Blob_GetBufferPointer(vsb), ID3D10Blob_GetBufferSize(vsb), NULL, &g_vs);
    if (FAILED(hr)) goto fail;
    hr = ID3D11Device_CreatePixelShader(g_device, ID3D10Blob_GetBufferPointer(psb), ID3D10Blob_GetBufferSize(psb), NULL, &g_ps);
    if (FAILED(hr)) goto fail;

    D3D11_INPUT_ELEMENT_DESC elements[] = {
        { "POSITION", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 0,  D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 8,  D3D11_INPUT_PER_VERTEX_DATA, 0 },
    };
    hr = ID3D11Device_CreateInputLayout(g_device, elements, 2,
                                        ID3D10Blob_GetBufferPointer(vsb), ID3D10Blob_GetBufferSize(vsb), &g_layout);
    if (FAILED(hr)) goto fail;

    D3D11_BUFFER_DESC bd = { 0 };
    bd.ByteWidth = sizeof(vertex_t) * 4;
    bd.Usage = D3D11_USAGE_DYNAMIC;
    bd.BindFlags = D3D11_BIND_VERTEX_BUFFER;
    bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    hr = ID3D11Device_CreateBuffer(g_device, &bd, NULL, &g_vbuf);
    if (FAILED(hr)) goto fail;

    D3D11_SAMPLER_DESC sd = { 0 };
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    sd.MaxLOD = D3D11_FLOAT32_MAX;
    hr = ID3D11Device_CreateSamplerState(g_device, &sd, &g_sampler);
    if (FAILED(hr)) goto fail;

    /* The bitmap arrives premultiplied, so the source factor is ONE. Using
     * SRC_ALPHA here would darken every edge in the toast. */
    D3D11_BLEND_DESC bld = { 0 };
    bld.RenderTarget[0].BlendEnable = TRUE;
    bld.RenderTarget[0].SrcBlend = D3D11_BLEND_ONE;
    bld.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
    bld.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
    bld.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
    bld.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
    bld.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
    bld.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    hr = ID3D11Device_CreateBlendState(g_device, &bld, &g_blend);
    if (FAILED(hr)) goto fail;

    D3D11_RASTERIZER_DESC rd = { 0 };
    rd.FillMode = D3D11_FILL_SOLID;
    rd.CullMode = D3D11_CULL_NONE;
    rd.DepthClipEnable = TRUE;
    hr = ID3D11Device_CreateRasterizerState(g_device, &rd, &g_raster);
    if (FAILED(hr)) goto fail;

    D3D11_DEPTH_STENCIL_DESC dsd = { 0 };
    dsd.DepthEnable = FALSE;
    dsd.StencilEnable = FALSE;
    hr = ID3D11Device_CreateDepthStencilState(g_device, &dsd, &g_depth);
    if (FAILED(hr)) goto fail;

    D3D11_TEXTURE2D_DESC td = { 0 };
    td.Width = LIBRARIAN_ACH_MAX_W;
    td.Height = LIBRARIAN_ACH_MAX_H;
    td.MipLevels = td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DYNAMIC;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    td.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    hr = ID3D11Device_CreateTexture2D(g_device, &td, NULL, &g_texture);
    if (FAILED(hr)) goto fail;
    hr = ID3D11Device_CreateShaderResourceView(g_device, (ID3D11Resource *)g_texture, NULL, &g_srv);
    if (FAILED(hr)) goto fail;

    ID3D10Blob_Release(vsb);
    ID3D10Blob_Release(psb);
    if (err) ID3D10Blob_Release(err);
    ov_log("[achoverlay] renderer ready");
    return 1;

fail:
    if (vsb) ID3D10Blob_Release(vsb);
    if (psb) ID3D10Blob_Release(psb);
    if (err) ID3D10Blob_Release(err);
    release_resources();
    return 0;
}

/* Copy the current frame from the shared section into the texture. */
static void upload_frame(void)
{
    D3D11_MAPPED_SUBRESOURCE map;
    if (FAILED(ID3D11DeviceContext_Map(g_context, (ID3D11Resource *)g_texture, 0,
                                       D3D11_MAP_WRITE_DISCARD, 0, &map))) return;

    const uint32_t w = g_shared->width  > LIBRARIAN_ACH_MAX_W ? LIBRARIAN_ACH_MAX_W : g_shared->width;
    const uint32_t h = g_shared->height > LIBRARIAN_ACH_MAX_H ? LIBRARIAN_ACH_MAX_H : g_shared->height;

    for (uint32_t row = 0; row < h; row++) {
        memcpy((uint8_t *)map.pData + (size_t)row * map.RowPitch,
               g_shared->pixels + (size_t)row * LIBRARIAN_ACH_MAX_W * 4,
               (size_t)w * 4);
    }
    ID3D11DeviceContext_Unmap(g_context, (ID3D11Resource *)g_texture, 0);
}

/* Place the quad in clip space from the anchor, the scale and the frame size. */
static int write_quad(IDXGISwapChain *chain)
{
    DXGI_SWAP_CHAIN_DESC desc;
    if (FAILED(IDXGISwapChain_GetDesc(chain, &desc))) return 0;
    const float fw = (float)desc.BufferDesc.Width;
    const float fh = (float)desc.BufferDesc.Height;
    if (fw < 1.0f || fh < 1.0f) return 0;

    /* Scale is expressed against the frame height so the toast keeps the same
     * apparent size at 1080p and at 4K. */
    const float px_h = fh * (g_shared->scale > 0.0f ? g_shared->scale : 0.10f);
    const float aspect = g_shared->height ? (float)g_shared->width / (float)g_shared->height : 4.0f;
    const float px_w = px_h * aspect;

    const float cx = fw * g_shared->anchor_x;
    const float cy = fh * g_shared->anchor_y + px_h * 0.5f;

    const float left   = cx - px_w * 0.5f;
    const float right  = cx + px_w * 0.5f;
    const float top    = cy - px_h * 0.5f;
    const float bottom = cy + px_h * 0.5f;

    /* Pixels to clip space: x right, y up. */
    const float l = (left   / fw) * 2.0f - 1.0f;
    const float r = (right  / fw) * 2.0f - 1.0f;
    const float t = 1.0f - (top    / fh) * 2.0f;
    const float b = 1.0f - (bottom / fh) * 2.0f;

    /* Only the used part of the atlas is sampled: the section is a fixed size
     * but the toast rarely fills it. */
    const float u = (float)g_shared->width  / (float)LIBRARIAN_ACH_MAX_W;
    const float v = (float)g_shared->height / (float)LIBRARIAN_ACH_MAX_H;

    const vertex_t quad[4] = {
        { l, b, 0.0f, v },
        { l, t, 0.0f, 0.0f },
        { r, b, u,    v },
        { r, t, u,    0.0f },
    };

    D3D11_MAPPED_SUBRESOURCE map;
    if (FAILED(ID3D11DeviceContext_Map(g_context, (ID3D11Resource *)g_vbuf, 0,
                                       D3D11_MAP_WRITE_DISCARD, 0, &map))) return 0;
    memcpy(map.pData, quad, sizeof quad);
    ID3D11DeviceContext_Unmap(g_context, (ID3D11Resource *)g_vbuf, 0);
    return 1;
}

/*
 * Everything the draw touches, saved and put back.
 *
 * This is the part that decides whether a game renders correctly or falls
 * apart two frames later, so it is exhaustive rather than clever: leaving one
 * of these behind produces a bug that looks like the game's fault and is
 * nearly impossible to attribute.
 */
typedef struct {
    ID3D11RenderTargetView   *rtv;
    ID3D11DepthStencilView   *dsv;
    ID3D11VertexShader       *vs;
    ID3D11PixelShader        *ps;
    ID3D11InputLayout        *layout;
    ID3D11Buffer             *vbuf;
    UINT                      stride, offset;
    D3D11_PRIMITIVE_TOPOLOGY  topology;
    ID3D11BlendState         *blend;
    FLOAT                     blend_factor[4];
    UINT                      sample_mask;
    ID3D11DepthStencilState  *depth;
    UINT                      stencil_ref;
    ID3D11RasterizerState    *raster;
    ID3D11ShaderResourceView *srv;
    ID3D11SamplerState       *sampler;
    UINT                      viewports;
    D3D11_VIEWPORT            viewport[D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE];
} saved_state_t;

static void save_state(saved_state_t *s)
{
    memset(s, 0, sizeof *s);
    ID3D11DeviceContext_OMGetRenderTargets(g_context, 1, &s->rtv, &s->dsv);
    ID3D11DeviceContext_VSGetShader(g_context, &s->vs, NULL, NULL);
    ID3D11DeviceContext_PSGetShader(g_context, &s->ps, NULL, NULL);
    ID3D11DeviceContext_IAGetInputLayout(g_context, &s->layout);
    ID3D11DeviceContext_IAGetVertexBuffers(g_context, 0, 1, &s->vbuf, &s->stride, &s->offset);
    ID3D11DeviceContext_IAGetPrimitiveTopology(g_context, &s->topology);
    ID3D11DeviceContext_OMGetBlendState(g_context, &s->blend, s->blend_factor, &s->sample_mask);
    ID3D11DeviceContext_OMGetDepthStencilState(g_context, &s->depth, &s->stencil_ref);
    ID3D11DeviceContext_RSGetState(g_context, &s->raster);
    ID3D11DeviceContext_PSGetShaderResources(g_context, 0, 1, &s->srv);
    ID3D11DeviceContext_PSGetSamplers(g_context, 0, 1, &s->sampler);
    s->viewports = D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE;
    ID3D11DeviceContext_RSGetViewports(g_context, &s->viewports, s->viewport);
}

#define PUT_BACK(obj, iface) do { if (obj) { iface##_Release(obj); (obj) = NULL; } } while (0)

static void restore_state(saved_state_t *s)
{
    ID3D11DeviceContext_OMSetRenderTargets(g_context, 1, &s->rtv, s->dsv);
    ID3D11DeviceContext_VSSetShader(g_context, s->vs, NULL, 0);
    ID3D11DeviceContext_PSSetShader(g_context, s->ps, NULL, 0);
    ID3D11DeviceContext_IASetInputLayout(g_context, s->layout);
    ID3D11DeviceContext_IASetVertexBuffers(g_context, 0, 1, &s->vbuf, &s->stride, &s->offset);
    ID3D11DeviceContext_IASetPrimitiveTopology(g_context, s->topology);
    ID3D11DeviceContext_OMSetBlendState(g_context, s->blend, s->blend_factor, s->sample_mask);
    ID3D11DeviceContext_OMSetDepthStencilState(g_context, s->depth, s->stencil_ref);
    ID3D11DeviceContext_RSSetState(g_context, s->raster);
    ID3D11DeviceContext_PSSetShaderResources(g_context, 0, 1, &s->srv);
    ID3D11DeviceContext_PSSetSamplers(g_context, 0, 1, &s->sampler);
    if (s->viewports) ID3D11DeviceContext_RSSetViewports(g_context, s->viewports, s->viewport);

    PUT_BACK(s->rtv, ID3D11RenderTargetView);
    PUT_BACK(s->dsv, ID3D11DepthStencilView);
    PUT_BACK(s->vs, ID3D11VertexShader);
    PUT_BACK(s->ps, ID3D11PixelShader);
    PUT_BACK(s->layout, ID3D11InputLayout);
    PUT_BACK(s->vbuf, ID3D11Buffer);
    PUT_BACK(s->blend, ID3D11BlendState);
    PUT_BACK(s->depth, ID3D11DepthStencilState);
    PUT_BACK(s->raster, ID3D11RasterizerState);
    PUT_BACK(s->srv, ID3D11ShaderResourceView);
    PUT_BACK(s->sampler, ID3D11SamplerState);
}

static void draw_overlay(IDXGISwapChain *chain)
{
    ID3D11Texture2D *back = NULL;
    ID3D11RenderTargetView *rtv = NULL;

    if (FAILED(IDXGISwapChain_GetBuffer(chain, 0, &IID_ID3D11Texture2D, (void **)&back))) return;
    if (FAILED(ID3D11Device_CreateRenderTargetView(g_device, (ID3D11Resource *)back, NULL, &rtv))) {
        ID3D11Texture2D_Release(back);
        return;
    }

    if (!write_quad(chain)) { ID3D11RenderTargetView_Release(rtv); ID3D11Texture2D_Release(back); return; }

    /* Only re-upload when Librarian says the pixels changed. A held toast
     * costs one draw call per frame and no bus traffic at all. */
    const uint32_t seq = g_shared->seq;
    if (seq != g_texture_seq) { upload_frame(); g_texture_seq = seq; }

    saved_state_t saved;
    save_state(&saved);

    DXGI_SWAP_CHAIN_DESC desc;
    IDXGISwapChain_GetDesc(chain, &desc);
    D3D11_VIEWPORT vp = { 0 };
    vp.Width = (FLOAT)desc.BufferDesc.Width;
    vp.Height = (FLOAT)desc.BufferDesc.Height;
    vp.MaxDepth = 1.0f;

    const UINT stride = sizeof(vertex_t), offset = 0;
    const FLOAT blend_factor[4] = { 0, 0, 0, 0 };

    ID3D11DeviceContext_RSSetViewports(g_context, 1, &vp);
    ID3D11DeviceContext_OMSetRenderTargets(g_context, 1, &rtv, NULL);
    ID3D11DeviceContext_IASetInputLayout(g_context, g_layout);
    ID3D11DeviceContext_IASetVertexBuffers(g_context, 0, 1, &g_vbuf, &stride, &offset);
    ID3D11DeviceContext_IASetPrimitiveTopology(g_context, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
    ID3D11DeviceContext_VSSetShader(g_context, g_vs, NULL, 0);
    ID3D11DeviceContext_PSSetShader(g_context, g_ps, NULL, 0);
    ID3D11DeviceContext_PSSetShaderResources(g_context, 0, 1, &g_srv);
    ID3D11DeviceContext_PSSetSamplers(g_context, 0, 1, &g_sampler);
    ID3D11DeviceContext_OMSetBlendState(g_context, g_blend, blend_factor, 0xFFFFFFFF);
    ID3D11DeviceContext_OMSetDepthStencilState(g_context, g_depth, 0);
    ID3D11DeviceContext_RSSetState(g_context, g_raster);
    ID3D11DeviceContext_Draw(g_context, 4, 0);

    restore_state(&saved);

    ID3D11RenderTargetView_Release(rtv);
    ID3D11Texture2D_Release(back);
}

/* ── The hook ─────────────────────────────────────────────────────*/
static void draw_if_shown(IDXGISwapChain *chain)
{
    if (!g_disabled && g_shared && g_shared->visible && g_shared->width && g_shared->height) {
        if (!g_device && !build_resources(chain)) g_disabled = 1;
        else draw_overlay(chain);
    }
}

static HRESULT STDMETHODCALLTYPE hooked_present(IDXGISwapChain *chain, UINT interval, UINT flags)
{
    tuning_before_present(chain, flags);
    draw_if_shown(chain);
    const HRESULT hr = g_present_original(chain, interval, flags);
    tuning_after_present(chain, flags, hr);
    return hr;
}

/* Present1 is what a flip-model game calls; same chain, same rules. */
typedef HRESULT (STDMETHODCALLTYPE *present1_fn)(IDXGISwapChain1 *, UINT, UINT, const DXGI_PRESENT_PARAMETERS *);
static present1_fn g_present1_original = NULL;

static HRESULT STDMETHODCALLTYPE hooked_present1(IDXGISwapChain1 *chain, UINT interval, UINT flags,
                                                 const DXGI_PRESENT_PARAMETERS *params)
{
    tuning_before_present((IDXGISwapChain *)chain, flags);
    draw_if_shown((IDXGISwapChain *)chain);
    const HRESULT hr = g_present1_original(chain, interval, flags, params);
    tuning_after_present((IDXGISwapChain *)chain, flags, hr);
    return hr;
}

static int patch_slot(void **slot, void *replacement, void **original)
{
    DWORD old;
    if (!VirtualProtect(slot, sizeof(void *), PAGE_EXECUTE_READWRITE, &old)) return 0;
    *original = *slot;
    *slot = replacement;
    VirtualProtect(slot, sizeof(void *), old, &old);
    return 1;
}

/*
 * The probe device below brings in NVIDIA's user-mode driver, which loads
 * System32\version.dll by full path. Once a module of that name is in the
 * process, every later import of "version.dll" binds to it, so a proxy the game
 * keeps beside its executable never loads. Measured on CONTROL Resonant,
 * 2026-09-26: the DLSSG SM86 proxy is normally pulled in by Streamline's
 * sl.common.dll a second after start; with the probe first, the system copy won
 * and frame generation vanished from the menu. Resolve the name the way the
 * game's own modules would, before the probe can decide it for them.
 */
static void keep_game_proxies(void)
{
    static const char *const names[] = { "version.dll" };
    char path[MAX_PATH];
    DWORD length = GetModuleFileNameA(NULL, path, MAX_PATH);
    if (!length || length >= MAX_PATH) return;
    char *slash = strrchr(path, '\\');
    if (!slash) return;
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
        if (GetModuleHandleA(names[i])) continue;     /* already decided */
        slash[1] = '\0';
        if (strlen(path) + strlen(names[i]) >= MAX_PATH) continue;
        strcat(path, names[i]);
        DWORD attributes = GetFileAttributesA(path);
        if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
        if (LoadLibraryA(path)) ov_log("[achoverlay] loaded the game's own %s before probing", names[i]);
        else ov_log("[achoverlay] the game's own %s did not load (error %lu)", names[i], GetLastError());
    }
}

/*
 * Find Present by making a throwaway swap chain.
 *
 * Its vtable is the one dxgi.dll hands to every chain in the process, so the
 * pointer found here is the pointer the game's chain will call.
 */
static int install_hook(void)
{
    if (steam_overlay_requested()) {
        tuning_disable_overlay_conflict();
        ov_log("[achoverlay] Steam overlay active or requested; Librarian render hooks skipped to prevent recursion");
        return 0;
    }
    WNDCLASSEXA wc = { 0 };
    wc.cbSize = sizeof wc;
    wc.lpfnWndProc = DefWindowProcA;
    wc.hInstance = GetModuleHandleA(NULL);
    wc.lpszClassName = "LibrarianAchProbe";
    if (!RegisterClassExA(&wc)) return 0;

    HWND wnd = CreateWindowExA(0, wc.lpszClassName, "", WS_OVERLAPPEDWINDOW,
                               0, 0, 64, 64, NULL, NULL, wc.hInstance, NULL);
    if (!wnd) { UnregisterClassA(wc.lpszClassName, wc.hInstance); return 0; }

    DXGI_SWAP_CHAIN_DESC scd = { 0 };
    scd.BufferCount = 1;
    scd.BufferDesc.Width = 64;
    scd.BufferDesc.Height = 64;
    scd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    scd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    scd.OutputWindow = wnd;
    scd.SampleDesc.Count = 1;
    scd.Windowed = TRUE;
    scd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    IDXGISwapChain *chain = NULL;
    ID3D11Device *device = NULL;
    ID3D11DeviceContext *context = NULL;
    D3D_FEATURE_LEVEL level = D3D_FEATURE_LEVEL_11_0;

    keep_game_proxies();
    HRESULT hr = D3D11CreateDeviceAndSwapChain(
        NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, 0, NULL, 0, D3D11_SDK_VERSION,
        &scd, &chain, &device, &level, &context);

    if (FAILED(hr) || !chain) {
        ov_log("[achoverlay] probe device failed 0x%08lX", hr);
        DestroyWindow(wnd);
        UnregisterClassA(wc.lpszClassName, wc.hInstance);
        return 0;
    }

    /* Device creation may have loaded Steam's renderer. Recheck before any
     * vtable mutation, releasing the probe normally on this path too. */
    if (steam_overlay_requested()) {
        tuning_disable_overlay_conflict();
        ov_log("[achoverlay] Steam overlay appeared during device creation; Librarian render hooks skipped");
        IDXGISwapChain_Release(chain);
        ID3D11DeviceContext_Release(context);
        ID3D11Device_Release(device);
        DestroyWindow(wnd);
        UnregisterClassA(wc.lpszClassName, wc.hInstance);
        return 0;
    }
    void **vtable = *(void ***)chain;
    unsigned hooked = 0;
    if (patch_slot(&vtable[8], (void *)hooked_present, (void **)&g_present_original)) hooked |= 1;

    /* The object behind an IDXGISwapChain is dxgi's one swap chain class, so
     * if it answers to IDXGISwapChain1 its vtable carries Present1 at entry 22
     * and the game's chain has the same one. */
    IDXGISwapChain1 *chain1 = NULL;
    if (SUCCEEDED(IDXGISwapChain_QueryInterface(chain, &IID_IDXGISwapChain1, (void **)&chain1)) && chain1) {
        void **vtable1 = *(void ***)chain1;
        if (patch_slot(&vtable1[22], (void *)hooked_present1, (void **)&g_present1_original)) hooked |= 2;
        IDXGISwapChain1_Release(chain1);
    }
    tuning_note_hooks(hooked);

    IDXGISwapChain_Release(chain);
    ID3D11DeviceContext_Release(context);
    ID3D11Device_Release(device);
    DestroyWindow(wnd);
    UnregisterClassA(wc.lpszClassName, wc.hInstance);

    ov_log("[achoverlay] Present %s at %p; Present1 %s at %p",
           (hooked & 1) ? "hooked" : "NOT hooked", (void *)g_present_original,
           (hooked & 2) ? "hooked" : "NOT hooked", (void *)g_present1_original);
    return hooked != 0;
}

static DWORD WINAPI overlay_thread(LPVOID unused)
{
    (void)unused;

    /* Two reasons to hook, either one enough. The tuning config is written
     * before the injector runs, so it is there at once when it exists at all.
     * The achievement section may not be published yet — a game takes a while
     * to reach its first frame, and so does Librarian to notice it started.
     * Twenty tries at half a second covers a slow start without spinning for
     * the life of the process. */
    int tuning = tuning_open(ov_log);
    for (int attempt = 0; attempt < 20 && !g_shared; attempt++) {
        if (open_shared()) break;
        if (tuning) break;                 /* hook now; keep looking for the section below */
        Sleep(500);
    }
    if (!g_shared && !tuning) { ov_log("[achoverlay] no shared section and no tuning config; staying out"); return 0; }
    if (!install_hook()) return 0;

    /* Two things may still be on their way: the achievement section (usually
     * within a second; the draw checks g_shared on every frame) and, for a
     * D3D12 game, the runtime itself — the ExecuteCommandLists hook can only go
     * in once d3d12.dll is loaded, and a big engine takes its time. A minute
     * covers both without spinning for the life of the process. */
    int d3d12 = tuning ? tuning_hook_d3d12() : 1;
    for (int attempt = 0; attempt < 120 && (!g_shared || !d3d12); attempt++) {
        Sleep(500);
        if (!g_shared && attempt < 20) open_shared();
        if (!d3d12) d3d12 = tuning_hook_d3d12();
        if (attempt >= 20 && d3d12) break;      /* the section is not coming; nothing left to wait for */
    }
    if (!g_shared) ov_log("[achoverlay] no shared section; toasts stay off%s", tuning ? ", tuning stays on" : "");
    return 0;
}

/* ── Steam achievement watch ──────────────────────────────────────
 * The toast is driven from Librarian, which learns about an unlock by watching
 * the emulator's save file. That only works for a game that calls StoreStats —
 * plenty call SetAchievement and never flush, and then nothing ever reaches
 * disk. We are already inside the process, so we can ask the library directly
 * and be right in both cases.
 *
 * Strictly read-only. SteamAPI_Init is never called from here: initialising
 * Steam on the game's behalf would change what the game sees, and whether the
 * game did it itself is exactly the thing worth knowing.
 *
 * Which ISteamUserStats to ask for is the whole difficulty. The flat
 * SteamAPI_ISteamUserStats_* exports are compiled against one vtable layout —
 * the interface version of the SDK the library was built from — while the
 * Steam client hands out whichever version it is asked for. Ask for a newer
 * one than the library knows and every method is off by a slot. Measured on
 * Big Walk, 2026-09-05: its Steamworks 1.53a knows VERSION012, the client
 * also serves VERSION013 (which dropped RequestCurrentStats, the first slot),
 * and a hard-coded list asked for 013 first. GetNumAchievements landed on
 * GetAchievementName and returned a pointer as a count (3505455138),
 * GetAchievementName landed on RequestUserStats, and formatting the "name"
 * it returned took the game down. A version list is a guess, and it guessed
 * wrong. Any game that runs its real steam_api64 under the real client —
 * online mode, SLSsteam — with an SDK older than the list is the same crash.
 *
 * So the library itself is asked, in order of how sure the answer is:
 *   1. its own versioned accessor, SteamAPI_SteamUserStats_vNNN. A real
 *      Steamworks exports exactly the one it was built for; an emulator
 *      exports every one it implements and its flat exports take any of
 *      them. Either way the highest that resolves matches the flat exports.
 *   2. the version string inside the module that implements the flat
 *      exports. The proxy forwards by name, so through it that module is the
 *      game's own steam_api64_o.dll, and a Steamworks too old for accessors,
 *      or newer than the proxy's export list, still names its version there.
 *   3. the historical guess list, last, and only because a library that
 *      hides its strings is not impossible.
 * Whatever came back is then treated as hostile until it has produced a sane
 * count and a readable first name: a "count" no app can have, or a name that
 * is not a short identifier at a readable address, is the wrong slot talking,
 * and the watch switches itself off. Everything runs under a handler as the
 * last line. A wrong overlay must cost a toast, never the game.
 */
typedef int         (__cdecl *steam_hsteamuser_fn)(void);
typedef void *      (__cdecl *steam_finduser_fn)(int, const char *);
typedef void *      (__cdecl *steam_accessor_fn)(void);
typedef unsigned    (__cdecl *steam_numach_fn)(void *);
typedef const char *(__cdecl *steam_achname_fn)(void *, unsigned);
typedef int         (__cdecl *steam_getach_fn)(void *, const char *, int *);

#define STEAM_WATCH_MAX 512
#define STEAM_NAME_MAX  128
/* Steam allows an app 5000 achievements. A "count" beyond that is a pointer
 * or a status code read through the wrong vtable slot, not a game. */
#define STEAM_COUNT_SANE 5000u
/* Highest accessor version worth asking for. VERSION013 is current; the
 * headroom covers a few years of Valve without a rebuild. */
#define STEAM_ACCESSOR_MAX 30

static const char STEAM_STATS_PREFIX[] = "STEAMUSERSTATS_INTERFACE_VERSION";

/* Can [p, p+len) be read without faulting? A fault would be caught by the
 * handler below, but a game may install a vectored handler that sees it
 * first and treats it as its own crash — so wild pointers are refused before
 * they are touched, not after. */
static int readable(const void *p, size_t len)
{
    if (!p) return 0;
    const unsigned char *at  = (const unsigned char *)p;
    const unsigned char *end = at + len;
    while (at < end) {
        MEMORY_BASIC_INFORMATION mbi;
        if (VirtualQuery(at, &mbi, sizeof mbi) != sizeof mbi) return 0;
        if (mbi.State != MEM_COMMIT) return 0;
        if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return 0;
        if (mbi.Protect == 0) return 0;
        at = (const unsigned char *)mbi.BaseAddress + mbi.RegionSize;
    }
    return 1;
}

/* Copy an achievement API name if it looks like one: a terminated run of
 * printable bytes at a readable address, shorter than the buffer. Anything
 * else — binary data, a run with no terminator, a pointer into nothing — is
 * refused, and the caller decides whether that means one bad entry or a
 * wrong interface. */
static int copy_name(char *dst, size_t dstlen, const char *src)
{
    if (!readable(src, dstlen)) return 0;
    size_t i = 0;
    for (; i < dstlen - 1; i++) {
        const unsigned char c = (unsigned char)src[i];
        if (c == 0) break;
        if (c < 0x20 || c == 0x7F) return 0;
        dst[i] = (char)c;
    }
    if (i == dstlen - 1 && src[i] != 0) return 0;   /* no terminator in range */
    dst[i] = '\0';
    return i > 0;
}

/* 1. The library's own accessor, highest version first. Through the proxy a
 * name may exist as a forwarder to something its target lacks (the proxy
 * exports the union of several Steamworks); GetProcAddress then simply
 * fails, and the next one down is tried. */
static void *stats_via_accessor(HMODULE steam, char *how, size_t howlen)
{
    for (int v = STEAM_ACCESSOR_MAX; v >= 1; v--) {
        char name[64];
        _snprintf(name, sizeof name, "SteamAPI_SteamUserStats_v%03d", v);
        steam_accessor_fn accessor = (steam_accessor_fn)GetProcAddress(steam, name);
        if (!accessor) continue;
        void *stats = accessor();
        if (stats) {
            _snprintf(how, howlen, "%s (the library's own accessor)", name);
            return stats;
        }
        ov_log("[steam] %s exists but returned nothing", name);
    }
    return NULL;
}

/* 2. The version string inside the module that implements the flat exports.
 * GetProcAddress resolves a forwarder to its target, so the address of a flat
 * export already points into the right module even through the proxy. The
 * image is walked section by section rather than as one span so that an
 * unmapped or discarded page is never touched. */
static void *stats_via_version_string(HMODULE steam, steam_finduser_fn finduser, int user,
                                      const void *flat_export, char *how, size_t howlen)
{
    HMODULE impl = NULL;
    if (!GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                            | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            (LPCSTR)flat_export, &impl) || !impl) impl = steam;

    const size_t plen = sizeof STEAM_STATS_PREFIX - 1;
    const unsigned char *base = (const unsigned char *)impl;
    if (!readable(base, sizeof(IMAGE_DOS_HEADER))) return NULL;
    const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return NULL;
    const IMAGE_NT_HEADERS *nt = (const IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    if (!readable(nt, sizeof *nt) || nt->Signature != IMAGE_NT_SIGNATURE) return NULL;

    int best = 0;
    const IMAGE_SECTION_HEADER *sec = IMAGE_FIRST_SECTION(nt);
    for (unsigned s = 0; s < nt->FileHeader.NumberOfSections; s++, sec++) {
        if (!(sec->Characteristics & IMAGE_SCN_MEM_READ)) continue;
        if (sec->Characteristics & IMAGE_SCN_MEM_DISCARDABLE) continue;
        const unsigned char *p = base + sec->VirtualAddress;
        const size_t len = sec->Misc.VirtualSize ? sec->Misc.VirtualSize : sec->SizeOfRawData;
        if (len < plen + 3 || !readable(p, len)) continue;
        for (size_t i = 0; i + plen + 3 <= len; i++) {
            if (p[i] != 'S' || memcmp(p + i, STEAM_STATS_PREFIX, plen) != 0) continue;
            const unsigned char *d = p + i + plen;
            if (d[0] < '0' || d[0] > '9' || d[1] < '0' || d[1] > '9'
                || d[2] < '0' || d[2] > '9') continue;
            const int v = (d[0] - '0') * 100 + (d[1] - '0') * 10 + (d[2] - '0');
            if (v > best) best = v;
            i += plen + 2;
        }
    }
    if (!best) return NULL;

    char version[64];
    _snprintf(version, sizeof version, "%s%03d", STEAM_STATS_PREFIX, best);
    void *stats = finduser(user, version);
    if (!stats) { ov_log("[steam] %s is named in the library but the client refused it", version); return NULL; }

    char who[MAX_PATH] = "";
    GetModuleFileNameA(impl, who, MAX_PATH);
    const char *file = strrchr(who, '\\');
    _snprintf(how, howlen, "%s (named in %s)", version, file ? file + 1 : who);
    return stats;
}

/* 3. The old guess list. Reached only by a library with neither an accessor
 * nor a version string, which is to say a library that hides them; the
 * sanity checks after this are what keep the guess from costing anything. */
static void *stats_via_guess(steam_finduser_fn finduser, int user, char *how, size_t howlen)
{
    static const char *VERSIONS[] = {
        "STEAMUSERSTATS_INTERFACE_VERSION013",
        "STEAMUSERSTATS_INTERFACE_VERSION012",
        "STEAMUSERSTATS_INTERFACE_VERSION011",
    };
    for (int i = 0; i < 3; i++) {
        void *stats = finduser(user, VERSIONS[i]);
        if (stats) {
            _snprintf(how, howlen, "%s (a guess: the library names no version)", VERSIONS[i]);
            return stats;
        }
    }
    return NULL;
}

/* One line per unlock, beside the pixel section and named the same way. The
 * launcher tails it; a file rather than a pipe so a missed read is not a lost
 * achievement. */
static void unlock_record(const char *api)
{
    /* GetEnvironmentVariable rather than getenv: this runs inside a game whose
     * CRT is not ours. And every failure says so — an unlock that vanishes
     * without a word is the one bug nobody can diagnose afterwards. */
    char local[MAX_PATH];
    if (!GetEnvironmentVariableA("LOCALAPPDATA", local, MAX_PATH)) {
        ov_log("[steam] no LOCALAPPDATA; %s not reported", api);
        return;
    }

    char dir[MAX_PATH];
    _snprintf(dir, sizeof dir, "%s\\Librarian\\overlay", local);
    CreateDirectoryA(dir, NULL);

    char path[MAX_PATH];
    _snprintf(path, sizeof path, "%s\\%lu.unlocks", dir, GetCurrentProcessId());

    HANDLE h = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        ov_log("[steam] cannot open %s (error %lu); %s not reported",
               path, GetLastError(), api);
        return;
    }
    char line[192];
    const int n = _snprintf(line, sizeof line, "%s\n", api);
    DWORD written = 0;
    if (n > 0 && !WriteFile(h, line, (DWORD)n, &written, NULL))
        ov_log("[steam] write failed for %s (error %lu)", api, GetLastError());
    CloseHandle(h);
}

static char          g_ach_names[STEAM_WATCH_MAX][STEAM_NAME_MAX];
static unsigned char g_ach_earned[STEAM_WATCH_MAX];

/* Everything that talks to the library. Called under the handler in
 * steam_watch_thread; keeps no state that would need unwinding. */
static void steam_watch_body(HMODULE steam)
{
    steam_hsteamuser_fn hsteamuser = (steam_hsteamuser_fn)GetProcAddress(steam, "SteamAPI_GetHSteamUser");
    steam_finduser_fn   finduser   = (steam_finduser_fn)GetProcAddress(steam, "SteamInternal_FindOrCreateUserInterface");
    steam_numach_fn     numach     = (steam_numach_fn)GetProcAddress(steam, "SteamAPI_ISteamUserStats_GetNumAchievements");
    steam_achname_fn    achname    = (steam_achname_fn)GetProcAddress(steam, "SteamAPI_ISteamUserStats_GetAchievementName");
    steam_getach_fn     getach     = (steam_getach_fn)GetProcAddress(steam, "SteamAPI_ISteamUserStats_GetAchievement");
    if (!hsteamuser || !numach || !achname || !getach) {
        ov_log("[steam] not a library we can read (flat stats exports missing)");
        return;
    }

    /* Non-zero only once the game has called SteamAPI_Init itself. */
    int user = 0;
    for (int i = 0; i < 240; i++) {
        user = hsteamuser();
        if (user) break;
        if (i == 20 || i == 60 || i == 120) ov_log("[steam] no SteamAPI_Init yet after %ds", i / 2);
        Sleep(500);
    }
    if (!user) {
        ov_log("[steam] the game never called SteamAPI_Init - its Steam integration is off, "
               "so no achievement can ever unlock");
        return;
    }
    ov_log("[steam] game initialised Steam (HSteamUser=%d)", user);

    /* LIBRARIAN_ACH_STATS=accessor|string|guess pins one resolution method.
     * A diagnostic: the paths a healthy library never reaches can then be
     * exercised on demand instead of trusted, and a support case can be
     * narrowed from outside the game. Inherited from the launcher, which is
     * what spawns the game. */
    char pin[16] = "";
    GetEnvironmentVariableA("LIBRARIAN_ACH_STATS", pin, sizeof pin);
    const int any = !pin[0];
    if (!any) ov_log("[steam] LIBRARIAN_ACH_STATS=%s: resolution pinned to that method", pin);

    char how[192] = "";
    void *stats = NULL;
    if (any || !strcmp(pin, "accessor"))
        stats = stats_via_accessor(steam, how, sizeof how);
    if (!stats && finduser && (any || !strcmp(pin, "string")))
        stats = stats_via_version_string(steam, finduser, user, (const void *)numach, how, sizeof how);
    if (!stats && finduser && (any || !strcmp(pin, "guess")))
        stats = stats_via_guess(finduser, user, how, sizeof how);
    if (!stats) {
        ov_log("[steam] no ISteamUserStats interface reachable (%s)",
               finduser ? "the library names no version and the client offered none"
                        : "no accessor and no SteamInternal_FindOrCreateUserInterface");
        return;
    }
    ov_log("[steam] user stats via %s", how);

    /* Definitions arrive with the user's stats, which the game may still be
     * fetching: an honest zero right after SteamAPI_Init is not a final
     * answer, so it is asked again for a while. */
    unsigned count = 0;
    for (int i = 0; i < 30; i++) {
        count = numach(stats);
        if (count) break;
        Sleep(1000);
        if (!hsteamuser()) { ov_log("[steam] game shut Steam down before any definition arrived"); return; }
    }
    if (!count) { ov_log("[steam] no achievement definitions after 30s; nothing to watch"); return; }
    if (count > STEAM_COUNT_SANE) {
        ov_log("[steam] %u \"achievement(s)\" is not a count: the interface from %s does not "
               "match the layout the flat exports were built for; watch off", count, how);
        return;
    }
    ov_log("[steam] %u achievement definition(s)", count);

    const unsigned watched = count > STEAM_WATCH_MAX ? STEAM_WATCH_MAX : count;
    if (count > STEAM_WATCH_MAX)
        ov_log("[steam] watching the first %u of %u", watched, count);

    unsigned already = 0, unreadable = 0;
    for (unsigned i = 0; i < watched; i++) {
        const char *n = achname(stats, i);
        g_ach_earned[i] = 0;
        if (!copy_name(g_ach_names[i], sizeof g_ach_names[i], n)) {
            g_ach_names[i][0] = '\0';
            if (i == 0) {
                ov_log("[steam] the first achievement name is not readable (%p) through %s: "
                       "wrong interface layout; watch off", (const void *)n, how);
                return;
            }
            unreadable++;
            continue;
        }
        int got = 0;
        g_ach_earned[i] = (getach(stats, g_ach_names[i], &got) && got) ? 1 : 0;
        already += g_ach_earned[i];
    }
    if (unreadable) ov_log("[steam] %u name(s) unreadable; skipped", unreadable);
    ov_log("[steam] %u already unlocked; watching the other %u", already, watched - already - unreadable);

    /* A game that shuts Steam down frees the interface underneath us. Checking
     * the user handle first closes most of that window; the handler in the
     * caller closes the rest, because a crash on the way out of a game is
     * worse than a missed toast. */
    for (;;) {
        Sleep(1000);
        if (!hsteamuser()) { ov_log("[steam] game shut Steam down; watch ends"); return; }
        for (unsigned i = 0; i < watched; i++) {
            if (g_ach_earned[i] || !g_ach_names[i][0]) continue;
            int got = 0;
            if (getach(stats, g_ach_names[i], &got) && got) {
                g_ach_earned[i] = 1;
                ov_log("[steam] unlocked: %s", g_ach_names[i]);
                unlock_record(g_ach_names[i]);
            }
        }
    }
}

static DWORD WINAPI steam_watch_thread(LPVOID unused)
{
    (void)unused;

    HMODULE steam = NULL;
    for (int i = 0; i < 120 && !steam; i++) {
        steam = GetModuleHandleA("steam_api64.dll");
        if (!steam) Sleep(500);
    }
    if (!steam) { ov_log("[steam] steam_api64.dll never loaded; nothing to watch"); return 0; }

    char who[MAX_PATH] = "";
    GetModuleFileNameA(steam, who, MAX_PATH);
    ov_log("[steam] steam_api64.dll at %s", who);

    __try {
        steam_watch_body(steam);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        ov_log("[steam] fault 0x%08lX inside the Steam library; watch ends, the game is untouched",
               GetExceptionCode());
    }
    return 0;
}

__declspec(dllexport) void librarian_achoverlay_init(void)
{
    static LONG started = 0;
    if (InterlockedExchange(&started, 1)) return;

    /* Never from DllMain's own thread: this creates a D3D device, which loads
     * more libraries, under the loader lock. */
    HANDLE t = CreateThread(NULL, 0, overlay_thread, NULL, 0, NULL);
    if (t) CloseHandle(t);

    /* Separate from the renderer: the toast can be drawn long before the game
     * finishes starting Steam, and neither should wait on the other. */
    HANDLE w = CreateThread(NULL, 0, steam_watch_thread, NULL, 0, NULL);
    if (w) CloseHandle(w);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        librarian_achoverlay_init();
    }
    return TRUE;
}
