import ctypes
from ctypes import wintypes
import json
import sys
import threading
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

try:
    user32.SetProcessDPIAware()
except Exception:
    pass

class RECT(ctypes.Structure):
    _fields_ = [
        ('left', wintypes.LONG),
        ('top', wintypes.LONG),
        ('right', wintypes.LONG),
        ('bottom', wintypes.LONG),
    ]

class POINT(ctypes.Structure):
    _fields_ = [
        ('x', wintypes.LONG),
        ('y', wintypes.LONG),
    ]

target_overlay_pid = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 0

cached_overlay_pids = set()
cached_non_overlay_pids = set()
print_lock = threading.Lock()

def safe_print(obj):
    with print_lock:
        try:
            sys.stdout.write(json.dumps(obj) + '\n')
            sys.stdout.flush()
        except Exception:
            pass

def is_overlay_pid(pid):
    if pid == 0:
        return False
    if target_overlay_pid != 0 and pid == target_overlay_pid:
        return True
    if pid in cached_overlay_pids:
        return True
    if pid in cached_non_overlay_pids:
        return False

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h_proc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h_proc:
        return False

    buf = ctypes.create_unicode_buffer(1024)
    size = wintypes.DWORD(1024)
    res = kernel32.QueryFullProcessImageNameW(h_proc, 0, buf, ctypes.byref(size))
    kernel32.CloseHandle(h_proc)

    if res:
        name = buf.value.lower()
        if 'genshin map overlay' in name or 'electron' in name:
            cached_overlay_pids.add(pid)
            return True
        else:
            cached_non_overlay_pids.add(pid)
            return False
    return False

def get_genshin_hwnd():
    for title in ["Genshin Impact", "原神", "원신"]:
        h = user32.FindWindowW("UnityWndClass", title)
        if h:
            return h
    h = user32.FindWindowW("UnityWndClass", None)
    if h:
        return h
    return 0

# Dedicated fast thread for right-click, F4, and M key detection
def input_watcher():
    rbutton_was_down = False
    f4_was_down = False
    m_was_down = False
    esc_was_down = False
    last_click_time = 0
    last_f4_time = 0
    last_m_time = 0
    last_esc_time = 0

    while True:
        try:
            # 0x02 = VK_RBUTTON (Right mouse button to mark pin)
            rbutton_down = (user32.GetAsyncKeyState(0x02) & 0x8000) != 0
            if rbutton_down and not rbutton_was_down:
                now = time.time()
                if now - last_click_time > 0.15:
                    last_click_time = now
                    pt_screen = POINT()
                    user32.GetCursorPos(ctypes.byref(pt_screen))
                    pt_client = POINT(pt_screen.x, pt_screen.y)
                    hwnd_target = get_genshin_hwnd()
                    client_ok = False
                    if hwnd_target:
                        user32.ScreenToClient(hwnd_target, ctypes.byref(pt_client))
                        client_ok = True
                    safe_print({
                        "rightClick": True,
                        "screenX": pt_screen.x,
                        "screenY": pt_screen.y,
                        "clientX": pt_client.x if client_ok else pt_screen.x,
                        "clientY": pt_client.y if client_ok else pt_screen.y
                    })
            rbutton_was_down = rbutton_down

            # 0x73 = VK_F4 (F4 key to mark collected / nearby pin)
            f4_down = (user32.GetAsyncKeyState(0x73) & 0x8000) != 0
            if f4_down and not f4_was_down:
                now = time.time()
                if now - last_f4_time > 0.2:
                    last_f4_time = now
                    safe_print({"markHotkey": True})
            f4_was_down = f4_down

            # 0x4D = VK_M (M key to toggle map in Genshin)
            m_down = (user32.GetAsyncKeyState(0x4D) & 0x8000) != 0
            if m_down and not m_was_down:
                now = time.time()
                if now - last_m_time > 0.25:
                    last_m_time = now
                    safe_print({"keyM": True})
            m_was_down = m_down

            # 0x1B = VK_ESCAPE (Esc key to exit map in Genshin)
            esc_down = (user32.GetAsyncKeyState(0x1B) & 0x8000) != 0
            if esc_down and not esc_was_down:
                now = time.time()
                if now - last_esc_time > 0.25:
                    last_esc_time = now
                    safe_print({"keyEsc": True})
            esc_was_down = esc_down

        except Exception:
            pass
        time.sleep(0.005)

input_thread = threading.Thread(target=input_watcher, daemon=True)
input_thread.start()

# Main thread handles parent monitoring and window tracking
parent_handle = None
if target_overlay_pid != 0:
    SYNCHRONIZE = 0x00100000
    parent_handle = kernel32.OpenProcess(SYNCHRONIZE, False, target_overlay_pid)

last_x, last_y, last_w, last_h = -9999, -9999, -9999, -9999
last_running = False
last_minimized = False
last_foreground = False
first_run = True
loop_count = 0

while True:
    try:
        loop_count += 1
        if parent_handle and loop_count % 50 == 0:
            WAIT_TIMEOUT = 258
            res = kernel32.WaitForSingleObject(parent_handle, 0)
            if res != WAIT_TIMEOUT:
                sys.exit(0)

        hwnd = get_genshin_hwnd()
        if not hwnd:
            if last_running or first_run:
                safe_print({"running": False})
                last_running = False
                last_foreground = False
                first_run = False
            time.sleep(0.1)
            continue

        genshin_pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(genshin_pid))

        fg = user32.GetForegroundWindow()
        fg_pid = wintypes.DWORD()
        if fg:
            user32.GetWindowThreadProcessId(fg, ctypes.byref(fg_pid))

        is_fg = (fg == hwnd) or (fg_pid.value != 0 and (fg_pid.value == genshin_pid.value or is_overlay_pid(fg_pid.value)))
        minimized = (user32.IsIconic(hwnd) != 0) or (user32.IsWindowVisible(hwnd) == 0)

        rect = RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rect))
        pt = POINT(rect.left, rect.top)
        user32.ClientToScreen(hwnd, ctypes.byref(pt))
        w = rect.right - rect.left
        h = rect.bottom - rect.top

        if (not last_running or minimized != last_minimized or is_fg != last_foreground or
            pt.x != last_x or pt.y != last_y or w != last_w or h != last_h or first_run):
            safe_print({
                "running": True,
                "foreground": bool(is_fg),
                "minimized": bool(minimized),
                "x": pt.x,
                "y": pt.y,
                "width": w,
                "height": h
            })
            last_running = True
            last_foreground = bool(is_fg)
            last_minimized = bool(minimized)
            last_x, last_y, last_w, last_h = pt.x, pt.y, w, h
            first_run = False

    except Exception:
        pass

    time.sleep(0.02)
