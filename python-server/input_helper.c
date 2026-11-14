#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>

Display *display;

void init_x11() {
    display = XOpenDisplay(NULL);
    if (!display) {
        fprintf(stderr, "Cannot open display\n");
        exit(1);
    }
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

void press_key(const char *key) {
    KeySym keysym = XStringToKeysym(key);
    if (!keysym) {
        if (strcmp(key, "Return") == 0) keysym = XK_Return;
        else if (strcmp(key, "Escape") == 0) keysym = XK_Escape;
        else if (strcmp(key, "Tab") == 0) keysym = XK_Tab;
        else if (strcmp(key, "BackSpace") == 0) keysym = XK_BackSpace;
        else if (strcmp(key, "Delete") == 0) keysym = XK_Delete;
        else if (strcmp(key, "Insert") == 0) keysym = XK_Insert;
        else if (strcmp(key, "Home") == 0) keysym = XK_Home;
        else if (strcmp(key, "End") == 0) keysym = XK_End;
        else if (strcmp(key, "Page_Up") == 0) keysym = XK_Page_Up;
        else if (strcmp(key, "Page_Down") == 0) keysym = XK_Page_Down;
        else if (strcmp(key, "Up") == 0) keysym = XK_Up;
        else if (strcmp(key, "Down") == 0) keysym = XK_Down;
        else if (strcmp(key, "Left") == 0) keysym = XK_Left;
        else if (strcmp(key, "Right") == 0) keysym = XK_Right;
        else {
            fprintf(stderr, "Unknown key: %s\n", key);
            return;
        }
    }
    
    KeyCode keycode = XKeysymToKeycode(display, keysym);
    if (!keycode) return;
    
    XTestFakeKeyEvent(display, keycode, True, CurrentTime);
    XTestFakeKeyEvent(display, keycode, False, CurrentTime);
    XFlush(display);
}

int main(int argc, char *argv[]) {
    init_x11();
    
    if (argc < 2) {
        fprintf(stderr, "Usage: input_helper <command> [args...]\n");
        fprintf(stderr, "Commands: --test, move <dx> <dy>, click <1|3>, doubleclick, key <keysym>\n");
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
        press_key(argv[2]);
        return 0;
    }
    
    fprintf(stderr, "Unknown command\n");
    return 1;
}
