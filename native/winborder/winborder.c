/*
 * Turn the Windows 11 window border off for one window, and back on again.
 *
 * Windows 11 paints a one-pixel border around every window. DWM composites it
 * outside anything the application draws, so it survives a frameless window, it
 * survives fullscreen, and it is invisible to a screenshot of the page — which
 * is exactly why it took so long to name. Measured on Librarian in Big Picture
 * at 1920x1080: RGB 54,54,54 down the left edge, 56,56,56 down the right,
 * 57,57,57 across the top and 58,58,58 across the bottom, with the page's own
 * pixels starting one in from each.
 *
 * The only way to remove it is to ask DWM, and Electron has no binding for
 * that. Hence this: one call against dwmapi, in its own executable, following
 * the same pattern as librarian_inject.
 *
 *   librarian_winborder <hwnd> off|on
 *
 * "on" restores the system default rather than picking a colour, so leaving
 * fullscreen gives the window back exactly the chrome Windows would have drawn.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

/* Not in every SDK's dwmapi.h, but the values are documented and stable. */
#define ATTR_CORNER_PREFERENCE 33
#define ATTR_BORDER_COLOR      34
#define CORNER_DEFAULT         0
#define CORNER_DONOTROUND      1
#define COLOR_NONE             0xFFFFFFFE
#define COLOR_DEFAULT          0xFFFFFFFF

typedef HRESULT(WINAPI *set_attr_fn)(HWND, DWORD, LPCVOID, DWORD);

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "usage: librarian_winborder <hwnd> off|on\n");
        return 1;
    }

    const HWND wnd = (HWND)(UINT_PTR)_strtoui64(argv[1], NULL, 10);
    if (!IsWindow(wnd)) {
        fprintf(stderr, "no such window: %s\n", argv[1]);
        return 2;
    }

    /* Resolved at run time, not linked: these attributes do not exist before
     * Windows 11, and the launcher must still start there. */
    HMODULE dwm = LoadLibraryA("dwmapi.dll");
    set_attr_fn set_attr = dwm ? (set_attr_fn)GetProcAddress(dwm, "DwmSetWindowAttribute") : NULL;
    if (!set_attr) {
        fprintf(stderr, "DwmSetWindowAttribute unavailable\n");
        return 3;
    }

    const int off = strcmp(argv[2], "off") == 0;
    COLORREF colour = off ? (COLORREF)COLOR_NONE : (COLORREF)COLOR_DEFAULT;
    DWORD corner = off ? CORNER_DONOTROUND : CORNER_DEFAULT;

    const HRESULT border = set_attr(wnd, ATTR_BORDER_COLOR, &colour, sizeof colour);
    const HRESULT corners = set_attr(wnd, ATTR_CORNER_PREFERENCE, &corner, sizeof corner);

    printf("border %s, corners %s\n",
           SUCCEEDED(border) ? "applied" : "unsupported",
           SUCCEEDED(corners) ? "applied" : "unsupported");
    return SUCCEEDED(border) ? 0 : 4;
}
