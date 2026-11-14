/*
 * input_helper_x11.c — native X11/XTest input injection helper.
 *
 * This is the "full control" backend: no permission prompts, works even
 * at the login screen, driven entirely by the XTest extension.
 *
 * Commands:
 *   --test
 *   move <dx> <dy>
 *   click <1|3>
 *   doubleclick
 *   key <name>              single key press+release
 *   keys <name> [name...]   sequential key press+release (not a combo)
 *   hotkey <name> [name...] hold all but the last, tap the last, release
 *                           in reverse order — e.g. `hotkey ctrl c` == Ctrl+C
 *
 * Key <name> values are generic, lowercase names shared with the Python
 * backends (base.py / server.py's SHORTCUT_KEYS), e.g. "ctrl", "alt",
 * "shift", "super", "tab", "enter", "esc", "up", "f1", or a plain
 * single character like "c". These are mapped to X11 KeySym names below;
 * anything not in the table falls through to XStringToKeysym() as-is so
 * raw X11 keysym names (e.g. "Return") still work too.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>

Display *display;

typedef struct {
    const char *name;
    const char *keysym_name;
} KeyAlias;

/* Generic name -> X11 keysym name. Only need to cover names actually sent
 * by server.py's SHORTCUT_KEYS plus the common single-key cases. */
static const KeyAlias KEY_ALIASES[] = {
    {"ctrl",        "Control_L"},
    {"control",     "Control_L"},
    {"shift",       "Shift_L"},
    {"alt",         "Alt_L"},
    {"super",       "Super_L"},
    {"win",         "Super_L"},
    {"windows",     "Super_L"},
    {"tab",         "Tab"},
    {"enter",       "Return"},
    {"return",      "Return"},
    {"esc",         "Escape"},
    {"escape",      "Escape"},
    {"space",       "space"},
    {"backspace",   "BackSpace"},
    {"delete",      "Delete"},
    {"del",         "Delete"},
    {"insert",      "Insert"},
    {"ins",         "Insert"},
    {"home",        "Home"},
    {"end",         "End"},
    {"pageup",      "Page_Up"},
    {"pagedown",    "Page_Down"},
    {"up",          "Up"},
    {"down",        "Down"},
    {"left",        "Left"},
    {"right",       "Right"},
    {"capslock",    "Caps_Lock"},
    {"caps_lock",   "Caps_Lock"},
    {"numlock",     "Num_Lock"},
    {"scrolllock",  "Scroll_Lock"},
    {"pause",       "Pause"},
    {"printscreen", "Print"},
    {"prtsc",       "Print"},
    {"f1",  "F1"},  {"f2",  "F2"},  {"f3",  "F3"},  {"f4",  "F4"},
    {"f5",  "F5"},  {"f6",  "F6"},  {"f7",  "F7"},  {"f8",  "F8"},
    {"f9",  "F9"},  {"f10", "F10"}, {"f11", "F11"}, {"f12", "F12"},
    {NULL, NULL}
};

void init_x11() {
    display = XOpenDisplay(NULL);
    if (!display) {
        fprintf(stderr, "Cannot open display\n");
        exit(1);
    }
}

/* Resolve a generic key name to an X11 KeyCode, or 0 if unresolvable. */
KeyCode resolve_keycode(const char *name) {
    const char *keysym_name = name;

    for (int i = 0; KEY_ALIASES[i].name != NULL; i++) {
        if (strcasecmp(name, KEY_ALIASES[i].name) == 0) {
            keysym_name = KEY_ALIASES[i].keysym_name;
            break;
        }
    }

    KeySym keysym = XStringToKeysym(keysym_name);
    if (keysym == NoSymbol && strlen(name) == 1) {
        /* Single printable character (letters, digits, punctuation) */
        keysym = XStringToKeysym(name);
    }
    if (keysym == NoSymbol) {
        fprintf(stderr, "Unknown key: %s\n", name);
        return 0;
    }

    KeyCode keycode = XKeysymToKeycode(display, keysym);
    if (!keycode) {
        fprintf(stderr, "No keycode for key: %s\n", name);
    }
    return keycode;
}

void move_mouse(int dx, int dy) {
    int x, y;
    Window root, child;
    int win_x, win_y;
    unsigned int mask;

    XQueryPointer(display, RootWindow(display, 0), &root, &child,
                  &x, &y, &win_x, &win_y, &mask);
    XWarpPointer(display, None, root, 0, 0, 0, 0, x + dx, y + dy);
    XFlush(display);
}

void click_mouse(int button) {
    int btn = button == 1 ? Button1 : Button3;
    XTestFakeButtonEvent(display, btn, True, CurrentTime);
    XTestFakeButtonEvent(display, btn, False, CurrentTime);
    XFlush(display);
}

void double_click() {
    click_mouse(1);
    usleep(50000);
    click_mouse(1);
}

/* Press and release a single key. Returns 1 on success. */
int tap_key(const char *name) {
    KeyCode keycode = resolve_keycode(name);
    if (!keycode) return 0;
    XTestFakeKeyEvent(display, keycode, True, CurrentTime);
    XTestFakeKeyEvent(display, keycode, False, CurrentTime);
    XFlush(display);
    return 1;
}

int key_down(const char *name) {
    KeyCode keycode = resolve_keycode(name);
    if (!keycode) return 0;
    XTestFakeKeyEvent(display, keycode, True, CurrentTime);
    XFlush(display);
    return 1;
}

int key_up(const char *name) {
    KeyCode keycode = resolve_keycode(name);
    if (!keycode) return 0;
    XTestFakeKeyEvent(display, keycode, False, CurrentTime);
    XFlush(display);
    return 1;
}

/* Sequential taps — NOT a combo (used for typing/queueing distinct keys). */
int do_keys(char **names, int count) {
    int ok = 1;
    for (int i = 0; i < count; i++) {
        if (!tap_key(names[i])) ok = 0;
    }
    return ok;
}

/* Real modifier-hold hotkey: hold all but the last, tap the last, then
 * release everything in reverse order. e.g. hotkey ctrl c -> Ctrl+C. */
int do_hotkey(char **names, int count) {
    if (count == 0) return 0;
    int ok = 1;

    for (int i = 0; i < count - 1; i++) {
        if (!key_down(names[i])) ok = 0;
    }
    if (!tap_key(names[count - 1])) ok = 0;
    for (int i = count - 2; i >= 0; i--) {
        if (!key_up(names[i])) ok = 0;
    }
    return ok;
}

int main(int argc, char *argv[]) {
    init_x11();

    if (argc < 2) {
        fprintf(stderr, "Usage: input_helper_x11 <command> [args...]\n");
        fprintf(stderr, "Commands: --test, move <dx> <dy>, click <1|3>, "
                        "doubleclick, key <name>, keys <name...>, "
                        "hotkey <name...>\n");
        return 1;
    }

    if (strcmp(argv[1], "--test") == 0) {
        printf("OK\n");
        return 0;
    }

    if (strcmp(argv[1], "move") == 0 && argc == 4) {
        move_mouse(atoi(argv[2]), atoi(argv[3]));
        return 0;
    }

    if (strcmp(argv[1], "click") == 0 && argc == 3) {
        click_mouse(atoi(argv[2]));
        return 0;
    }

    if (strcmp(argv[1], "doubleclick") == 0) {
        double_click();
        return 0;
    }

    if (strcmp(argv[1], "key") == 0 && argc == 3) {
        return tap_key(argv[2]) ? 0 : 1;
    }

    if (strcmp(argv[1], "keys") == 0 && argc >= 3) {
        return do_keys(&argv[2], argc - 2) ? 0 : 1;
    }

    if (strcmp(argv[1], "hotkey") == 0 && argc >= 3) {
        return do_hotkey(&argv[2], argc - 2) ? 0 : 1;
    }

    fprintf(stderr, "Unknown command\n");
    return 1;
}
