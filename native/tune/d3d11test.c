/*
 * A GPU-bound Direct3D 11 application, for testing the in-game DLL.
 *
 * Verifying a render-queue cap or a frame limiter against a real game gives one
 * data point on one machine on one day. This gives a control: a window that
 * draws a full-screen triangle through a deliberately expensive pixel shader,
 * with V-Sync off, whose CPU cost per frame is nothing. The GPU is the
 * bottleneck by construction, so DXGI's default queue fills to its maximum,
 * the limiter has something to hold back, and both effects can be measured
 * with the same stats file the Tuning page reads.
 *
 *   librarian_d3d11test [iterations] [seconds] [--present1] [--buffers N]
 *
 *   iterations   shader loop count per pixel; more is slower (default 400)
 *   seconds      how long to run before exiting 0 (default 120)
 *   --present1   flip model through CreateSwapChainForHwnd and Present1 with
 *                tearing allowed — the path modern engines take with V-Sync
 *                off — instead of the blt model and Present
 *   --buffers N  back buffers in the chain (default 1 for blt, 3 for flip)
 *   --cpu MS     busy the CPU for MS milliseconds before each frame's draw,
 *                the way a game's simulation does — with enough of it the CPU,
 *                not the GPU, becomes the bottleneck, which is the case a
 *                queue cap must not make worse
 *
 * Exits 0 after `seconds`, 3 if Direct3D cannot be created. Never shipped:
 * built into dev/bin by dev/verify-tuning.mjs.
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "dxguid.lib")
#pragma comment(lib, "d3dcompiler.lib")
#pragma comment(lib, "user32.lib")

static const char *SHADER =
    "cbuffer C : register(b0) { uint iterations; float t; float2 pad; };\n"
    "struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };\n"
    "VSOut VSMain(uint id : SV_VertexID) {\n"
    "  VSOut o; float2 uv = float2((id << 1) & 2, id & 2);\n"
    "  o.pos = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1); o.uv = uv; return o;\n"
    "}\n"
    "float4 PSMain(VSOut i) : SV_TARGET {\n"
    "  float v = 0.0;\n"
    "  [loop] for (uint k = 0; k < iterations; k++) {\n"
    "    v += sin(i.uv.x * (k + 1) + t) * cos(i.uv.y * (k + 2) - t);\n"
    "  }\n"
    "  v = 0.5 + 0.5 * sin(v);\n"
    "  return float4(v, v * 0.6, 1.0 - v, 1);\n"
    "}\n";

typedef struct { UINT iterations; float t; float pad[2]; } constants_t;

static LRESULT CALLBACK wndproc(HWND h, UINT m, WPARAM w, LPARAM l)
{
    if (m == WM_CLOSE || m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcA(h, m, w, l);
}

int main(int argc, char **argv)
{
    UINT iterations = 400;
    double seconds = 120.0;
    int present1 = 0;
    UINT buffers = 0;
    double cpu_ms = 0.0;
    int positional = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--present1")) present1 = 1;
        else if (!strcmp(argv[i], "--buffers") && i + 1 < argc) buffers = (UINT)atoi(argv[++i]);
        else if (!strcmp(argv[i], "--cpu") && i + 1 < argc) cpu_ms = atof(argv[++i]);
        else if (positional == 0 && atoi(argv[i]) > 0) { iterations = (UINT)atoi(argv[i]); positional++; }
        else if (positional == 1 && atof(argv[i]) > 0) { seconds = atof(argv[i]); positional++; }
    }
    if (!buffers) buffers = present1 ? 3 : 1;

    WNDCLASSEXA wc = { 0 };
    wc.cbSize = sizeof wc;
    wc.lpfnWndProc = wndproc;
    wc.hInstance = GetModuleHandleA(NULL);
    wc.lpszClassName = "LibrarianD3D11Test";
    RegisterClassExA(&wc);
    HWND wnd = CreateWindowExA(0, wc.lpszClassName, "Librarian D3D11 test", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                               80, 80, 640, 360, NULL, NULL, wc.hInstance, NULL);
    if (!wnd) return 3;

    ID3D11Device *dev = NULL;
    ID3D11DeviceContext *ctx = NULL;
    IDXGISwapChain *chain = NULL;
    IDXGISwapChain1 *chain1 = NULL;
    D3D_FEATURE_LEVEL level;
    HRESULT hr;

    if (!present1) {
        DXGI_SWAP_CHAIN_DESC scd = { 0 };
        scd.BufferCount = buffers;
        scd.BufferDesc.Width = 640;
        scd.BufferDesc.Height = 360;
        scd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        scd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        scd.OutputWindow = wnd;
        scd.SampleDesc.Count = 1;
        scd.Windowed = TRUE;
        scd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
        hr = D3D11CreateDeviceAndSwapChain(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, 0, NULL, 0, D3D11_SDK_VERSION,
                                           &scd, &chain, &dev, &level, &ctx);
        if (FAILED(hr)) { fprintf(stderr, "D3D11CreateDeviceAndSwapChain 0x%08lX\n", hr); return 3; }
    } else {
        hr = D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, 0, NULL, 0, D3D11_SDK_VERSION, &dev, &level, &ctx);
        if (FAILED(hr)) { fprintf(stderr, "D3D11CreateDevice 0x%08lX\n", hr); return 3; }
        IDXGIDevice *dxgidev = NULL;
        IDXGIAdapter *adapter = NULL;
        IDXGIFactory2 *factory = NULL;
        ID3D11Device_QueryInterface(dev, &IID_IDXGIDevice, (void **)&dxgidev);
        IDXGIDevice_GetAdapter(dxgidev, &adapter);
        IDXGIAdapter_GetParent(adapter, &IID_IDXGIFactory2, (void **)&factory);
        DXGI_SWAP_CHAIN_DESC1 d = { 0 };
        d.Width = 640; d.Height = 360;
        d.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        d.SampleDesc.Count = 1;
        d.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        d.BufferCount = buffers < 2 ? 2 : buffers;
        d.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
        /* Tearing allowed, or the compositor would hold a windowed flip chain
         * to the refresh rate and the GPU would never be the bottleneck. */
        d.Flags = DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING;
        hr = IDXGIFactory2_CreateSwapChainForHwnd(factory, (IUnknown *)dev, wnd, &d, NULL, NULL, &chain1);
        IDXGIFactory2_Release(factory); IDXGIAdapter_Release(adapter); IDXGIDevice_Release(dxgidev);
        if (FAILED(hr)) { fprintf(stderr, "CreateSwapChainForHwnd 0x%08lX\n", hr); return 3; }
        chain = (IDXGISwapChain *)chain1;
    }

    ID3DBlob *vsb = NULL, *psb = NULL, *err = NULL;
    if (FAILED(D3DCompile(SHADER, strlen(SHADER), NULL, NULL, NULL, "VSMain", "vs_5_0", 0, 0, &vsb, &err)) ||
        FAILED(D3DCompile(SHADER, strlen(SHADER), NULL, NULL, NULL, "PSMain", "ps_5_0", 0, 0, &psb, &err))) {
        fprintf(stderr, "shader: %s\n", err ? (char *)ID3D10Blob_GetBufferPointer(err) : "?");
        return 3;
    }
    ID3D11VertexShader *vs = NULL;
    ID3D11PixelShader *ps = NULL;
    ID3D11Device_CreateVertexShader(dev, ID3D10Blob_GetBufferPointer(vsb), ID3D10Blob_GetBufferSize(vsb), NULL, &vs);
    ID3D11Device_CreatePixelShader(dev, ID3D10Blob_GetBufferPointer(psb), ID3D10Blob_GetBufferSize(psb), NULL, &ps);

    D3D11_BUFFER_DESC bd = { 0 };
    bd.ByteWidth = sizeof(constants_t);
    bd.Usage = D3D11_USAGE_DYNAMIC;
    bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    ID3D11Buffer *cb = NULL;
    ID3D11Device_CreateBuffer(dev, &bd, NULL, &cb);

    ID3D11Texture2D *back = NULL;
    ID3D11RenderTargetView *rtv = NULL;
    IDXGISwapChain_GetBuffer(chain, 0, &IID_ID3D11Texture2D, (void **)&back);
    ID3D11Device_CreateRenderTargetView(dev, (ID3D11Resource *)back, NULL, &rtv);

    D3D11_VIEWPORT vp = { 0, 0, 640, 360, 0, 1 };
    LARGE_INTEGER freq, start, now;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&start);
    unsigned frames = 0;

    for (;;) {
        MSG msg;
        while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) goto done;
            TranslateMessage(&msg);
            DispatchMessageA(&msg);
        }
        QueryPerformanceCounter(&now);
        const double elapsed = (double)(now.QuadPart - start.QuadPart) / (double)freq.QuadPart;
        if (elapsed >= seconds) break;

        /* The "simulation": a busy loop, because a game's CPU work is not a
         * sleep — it keeps a core hot and can never overlap with itself. */
        if (cpu_ms > 0.0) {
            LARGE_INTEGER t0, t;
            QueryPerformanceCounter(&t0);
            volatile double sink = 0.0;
            do {
                for (int k = 0; k < 2000; k++) sink += (double)k * 1e-9;
                QueryPerformanceCounter(&t);
            } while ((double)(t.QuadPart - t0.QuadPart) * 1000.0 / (double)freq.QuadPart < cpu_ms);
        }

        D3D11_MAPPED_SUBRESOURCE map;
        if (SUCCEEDED(ID3D11DeviceContext_Map(ctx, (ID3D11Resource *)cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &map))) {
            constants_t c = { iterations, (float)elapsed, { 0, 0 } };
            memcpy(map.pData, &c, sizeof c);
            ID3D11DeviceContext_Unmap(ctx, (ID3D11Resource *)cb, 0);
        }
        ID3D11DeviceContext_RSSetViewports(ctx, 1, &vp);
        ID3D11DeviceContext_OMSetRenderTargets(ctx, 1, &rtv, NULL);
        ID3D11DeviceContext_IASetInputLayout(ctx, NULL);
        ID3D11DeviceContext_IASetPrimitiveTopology(ctx, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ID3D11DeviceContext_VSSetShader(ctx, vs, NULL, 0);
        ID3D11DeviceContext_PSSetShader(ctx, ps, NULL, 0);
        ID3D11DeviceContext_PSSetConstantBuffers(ctx, 0, 1, &cb);
        ID3D11DeviceContext_Draw(ctx, 3, 0);

        if (present1) {
            DXGI_PRESENT_PARAMETERS pp = { 0 };
            hr = IDXGISwapChain1_Present1(chain1, 0, DXGI_PRESENT_ALLOW_TEARING, &pp);
        } else {
            hr = IDXGISwapChain_Present(chain, 0, 0);
        }
        if (FAILED(hr)) { fprintf(stderr, "Present 0x%08lX\n", hr); break; }
        frames++;
    }
done:
    printf("frames=%u\n", frames);
    return 0;
}
