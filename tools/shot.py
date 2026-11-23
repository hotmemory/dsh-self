# 截图，但不把图放进对话。
#
# 用法：
#   python shot.py                        # 截游戏客户区 → 存盘 → 打印路径
#   python shot.py --rect 400,470,500,120 # 只截一块（客户区坐标）
#   python shot.py --vl "图里余额是多少"   # 截完直接用本地视觉模型读成文字
#   python shot.py --ocr                  # 截完用 Windows OCR 转文字（大字更准）
#
# 为什么要有它：DSH 的截图工具会把图片塞进对话，攒多了顶到图片预算
# （"images exceed the route budget ... must be offloaded"）。
# 这个脚本把图留在磁盘上，进对话的只有路径和文字。
import io
import os
import subprocess
import sys
import time

from PIL import ImageGrab

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ORIG_PS = os.path.join(HERE, "ui_origin.ps1")
SHOT_DIR = r"C:\Users\meigu\dsh-self\wants-audit"
GAME_TITLE = "Probably Stolen"
VL = os.path.join(HERE, "look_vl.py")
OCR = os.path.join(HERE, "win-ocr.ps1")


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def game_hwnd():
    ps = ("Get-Process | Where-Object { $_.MainWindowTitle -eq '" + GAME_TITLE +
          "' } | Select-Object -First 1 -ExpandProperty Id")
    r = subprocess.run(["powershell.exe", "-NoProfile", "-Command", ps],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    pid = (r.stdout or "").strip()
    if not pid:
        return None
    r2 = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                         f"(Get-Process -Id {pid}).MainWindowHandle.ToInt64()"],
                        capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        return int((r2.stdout or "0").strip())
    except ValueError:
        return None


def origin(h):
    r = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                        "-File", ORIG_PS, "-Hwnd", str(h)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    parts = (r.stdout or "").strip().split(",")
    if len(parts) < 4:
        raise SystemExit("取不到窗口位置")
    return int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])


def clean(keep=2):
    """只保留最新 N 张（默认 2）——正在看的那张不会被删掉。"""
    shots = sorted(
        (os.path.getmtime(p), p)
        for p in (os.path.join(SHOT_DIR, f) for f in os.listdir(SHOT_DIR))
        if os.path.isfile(p) and f.lower().endswith((".png", ".jpg", ".jpeg"))
    )
    removed = []
    for _, p in shots[:-keep] if len(shots) > keep else []:
        try:
            os.remove(p)
            removed.append(os.path.basename(p))
        except OSError:
            pass
    return removed


def main():
    if "--del" in sys.argv:
        n = 0 if "all" in sys.argv else 2
        if "all" in sys.argv:
            for f in os.listdir(SHOT_DIR):
                if f.lower().endswith((".png", ".jpg", ".jpeg")):
                    try:
                        os.remove(os.path.join(SHOT_DIR, f))
                        n += 1
                    except OSError:
                        pass
            print("全删 %d 张" % n)
        else:
            removed = clean(2)
            print("删了：%s（保留最新 2 张）" % (", ".join(removed) if removed else "（无）"))
        return 0

    h = game_hwnd()
    rect_arg = arg("--rect")
    name = arg("--name") or time.strftime("shot_%H%M%S")

    if h:
        ox, oy, cw, ch = origin(h)
    else:
        ox = oy = 0
        cw, ch = 1920, 1080
    if cw == 0 or ch == 0:
        print("⚠ 游戏窗口是 0x0（最小化或已隐藏），没截图。")
        return 3

    if rect_arg:
        x, y, w, hh = [int(v) for v in rect_arg.split(",")]
    else:
        x, y, w, hh = 0, 0, cw, ch

    os.makedirs(SHOT_DIR, exist_ok=True)
    png = "--png" in sys.argv
    quality = 75
    if "--q" in sys.argv:
        quality = int(arg("--q"))
    path = os.path.join(SHOT_DIR, name + (".png" if png else ".jpg"))
    box = (ox + x, oy + y, ox + x + w, oy + y + hh)
    img = ImageGrab.grab(bbox=box)

    # 空图自检：全黑或几乎没明暗差，说明没抓到画面（PrintWindow 对 Unity 独显就返回纯黑）
    small = img.convert("L").resize((160, 90))
    px = list((getattr(small, "get_flattened_data", None) or small.getdata)())
    avg = sum(px) / len(px)
    lo, hi = min(px), max(px)
    if avg < 8 or (hi - lo) < 6:
        print("⚠ 空图（平均亮度 %.1f，明暗差 %d）—— 窗口可能不在前台或还在加载，没保存。" % (avg, hi - lo))
        return 2

    if "--png" in sys.argv:
        img.save(path)
    else:
        # 不预设"JPEG 一定更小"：像素画 PNG 往往更小，照片级画面 JPEG 小得多。
        # 两个都编码，留小的那个——这是实测出来的，不是抄来的默认值。
        buf_png, buf_jpg = io.BytesIO(), io.BytesIO()
        img.save(buf_png, "PNG")
        img.save(buf_jpg, "JPEG", quality=quality, optimize=True)
        use_jpg = buf_jpg.tell() < buf_png.tell()
        fmt = "JPEG q%d" % quality if use_jpg else "PNG"
        data = buf_jpg.getvalue() if use_jpg else buf_png.getvalue()
        path = os.path.join(SHOT_DIR, name + (".jpg" if use_jpg else ".png"))
        with open(path, "wb") as f:
            f.write(data)
    kb = os.path.getsize(path) / 1024
    print(path)
    print("（%dx%d %s %.0f KB 亮度 %.0f）" % (img.size[0], img.size[1], fmt, kb, avg))

    if "--vl" in sys.argv:
        prompt = arg("--vl")
        r = subprocess.run([sys.executable, VL, path, prompt],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        print("--- VL ---")
        print((r.stdout or "").strip() or (r.stderr or "").strip()[-300:])

    if "--ocr" in sys.argv:
        r = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                            "-File", OCR, "-Path", path],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        print("--- OCR ---")
        print((r.stdout or "").strip())
    return 0


sys.exit(main())
