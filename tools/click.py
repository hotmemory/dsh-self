# 可靠的鼠标点击：绝对坐标 SendInput + 点完回读光标，偏了就报"可能没生效"。
#
# 为什么不用 SetCursorPos + mouse_event：
#   mouse_event 对某些 Unity 全屏游戏无效——事件发出去了，游戏不理你。
#   SendInput 用绝对坐标一次做完，更接近真实输入。
# 为什么点完要回读光标：
#   偏了 3 像素以上，几乎一定是没点中；不查就等于假装成功。
#
# 用法：
#   python click.py 640 360                 # 客户区像素坐标
#   python click.py 85% 91%                 # 百分比（换分辨率也能用）
#   python click.py 85% 91% --right         # 右键
#   python click.py --where                 # 看窗口客户区、屏幕、光标
#   python click.py 640 360 --title "Probably Stolen"
import ctypes
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

user32 = ctypes.windll.user32

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class _INPUTunion(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("union", _INPUTunion)]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def _send(flags, dx=0, dy=0):
    inp = INPUT()
    inp.type = 0
    inp.union.mi.dx = dx
    inp.union.mi.dy = dy
    inp.union.mi.dwFlags = flags
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


def cursor():
    p = POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def find_window(title):
    hwnd = user32.FindWindowW(None, title)
    if hwnd:
        return hwnd
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(h, _):
        n = user32.GetWindowTextLengthW(h)
        if n:
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(h, buf, n + 1)
            if title.lower() in buf.value.lower():
                found.append(h)
        return True

    user32.EnumWindows(cb, None)
    return found[0] if found else 0


def client_origin(hwnd):
    r = RECT()
    user32.GetClientRect(hwnd, ctypes.byref(r))
    pt = POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return pt.x, pt.y, r.right - r.left, r.bottom - r.top


def main(argv):
    title = "Probably Stolen"
    if "--title" in argv:
        title = argv[argv.index("--title") + 1]

    hwnd = find_window(title)
    if not hwnd:
        print("找不到窗口：", title)
        return 1
    ox, oy, w, h = client_origin(hwnd)

    # 窗口最小化/隐藏时客户区是 0x0、原点会是 -32000——那种状态下点下去毫无意义。
    # 先还原再量一次；还不行就明确说"没动"，不要假装点过。
    if w == 0 or h == 0:
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        time.sleep(0.8)
        ox, oy, w, h = client_origin(hwnd)
        if w == 0 or h == 0:
            print("⚠ 窗口是 0x0（最小化或已隐藏），没有点击。先把它恢复再试。")
            return 3
        print("（窗口原本最小化，已还原）")

    if "--where" in argv:
        print("窗口句柄 %d  客户区原点 (%d,%d)  大小 %dx%d" % (hwnd, ox, oy, w, h))
        print("屏幕 %dx%d  光标 (%d,%d)" % (user32.GetSystemMetrics(0), user32.GetSystemMetrics(1), *cursor()))
        return 0

    args = [a for a in argv[1:] if not a.startswith("--") and a != title]
    if len(args) < 2:
        print(__doc__)
        return 1

    def parse(v, full):
        return int(float(v[:-1]) / 100 * full) if v.endswith("%") else int(v)

    cx, cy = parse(args[0], w), parse(args[1], h)
    right = "--right" in argv

    user32.SetForegroundWindow(hwnd)
    time.sleep(0.35)

    sx, sy = ox + cx, oy + cy
    sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    _send(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE,
          int(sx * 65535 / (sw - 1)), int(sy * 65535 / (sh - 1)))
    time.sleep(0.12)
    _send(MOUSEEVENTF_RIGHTDOWN if right else MOUSEEVENTF_LEFTDOWN)
    time.sleep(0.09)
    _send(MOUSEEVENTF_RIGHTUP if right else MOUSEEVENTF_LEFTUP)
    time.sleep(0.25)

    x, y = cursor()
    print("客户区 (%d,%d) → 屏幕 (%d,%d)；点完光标 (%d,%d)" % (cx, cy, sx, sy, x, y))
    if abs(x - sx) > 3 or abs(y - sy) > 3:
        print("⚠ 光标没到位（偏了 %d,%d）—— 点击可能没生效" % (x - sx, y - sy))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
