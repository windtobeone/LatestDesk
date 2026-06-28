import os
import sys
import base64
from PIL import Image, ImageDraw, ImageFont

def colorize_to_solid(img, color=(255, 255, 255, 255)):
    """将一个透明 PNG 图像所有非透明区域着色为纯色"""
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    r, g, b, a = img.split()
    solid_img = Image.new("RGBA", img.size, color)
    # 使用原始图像的 Alpha 通道进行遮罩混合
    return Image.composite(solid_img, Image.new("RGBA", img.size, (0, 0, 0, 0)), a)

def generate_icons(logo_base64_str, app_name, target_dir="."):
    # 1. 解码 Base64 到临时 PNG 文件
    logo_data = base64.b64decode(logo_base64_str)
    temp_png = os.path.join(target_dir, "temp_logo_source.png")
    with open(temp_png, "wb") as f:
        f.write(logo_data)

    img = Image.open(temp_png)
    if img.mode != 'RGBA':
        img = img.convert('RGBA')

    print(f"🚀 基于您的 logo.txt 经验，开始执行全平台深度图标定制部署 (应用名称: {app_name})...")

    # ==========================================
    # 1. 通用打包原图部署与 macOS 启动器母图
    # ==========================================
    res_dir = os.path.join(target_dir, "res")
    if os.path.exists(res_dir):
        # 部署通用打包图
        img.save(os.path.join(res_dir, "icon.png"), "PNG")
        
        # 部署 macOS 启动器源图 (缩小至 85% 并居中，符合苹果圆形图标留白规范)
        mac_icon_large = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        resized_85 = img.resize((870, 870), Image.Resampling.LANCZOS)
        mac_icon_large.paste(resized_85, (77, 77))
        mac_icon_large.save(os.path.join(res_dir, "mac-icon.png"), "PNG")
        print("✅ 通用打包母图及 macOS 启动器源图部署完成")
    else:
        print(f"⏭️  未找到 res 目录，跳过通用打包母图生成")

    # ==========================================
    # 2. Windows 图标与托盘图标 (.ico)
    # ==========================================
    win_res_dir = os.path.join(target_dir, "flutter", "windows", "runner", "resources")
    if os.path.exists(win_res_dir):
        # 生成 Windows 主程序图标
        img.save(os.path.join(win_res_dir, "app_icon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
        
        # 如果 res 目录存在，生成 Windows 专属 ico 备用
        if os.path.exists(res_dir):
            img.save(os.path.join(res_dir, "icon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
            # 托盘图标 (一般为 16x16, 32x32)
            img.save(os.path.join(res_dir, "tray-icon.ico"), format="ICO", sizes=[(16, 16), (32, 32)])
        print("✅ Windows 主程序图标与托盘图标生成完成")
    else:
        print(f"⏭️  未找到 Windows 资源目录，跳过 Windows 图标生成")

    # ==========================================
    # 3. macOS 托盘黑白双色图标部署
    # ==========================================
    if os.path.exists(res_dir):
        # 黑暗模式托盘图标 (纯白)
        mac_tray_dark = colorize_to_solid(img, (255, 255, 255, 255)).resize((32, 32), Image.Resampling.LANCZOS)
        mac_tray_dark.save(os.path.join(res_dir, "mac-tray-dark-x2.png"), "PNG")
        
        # 明亮模式托盘图标 (纯黑)
        mac_tray_light = colorize_to_solid(img, (0, 0, 0, 255)).resize((32, 32), Image.Resampling.LANCZOS)
        mac_tray_light.save(os.path.join(res_dir, "mac-tray-light-x2.png"), "PNG")
        print("✅ macOS 托盘黑白双色图标生成完成")

    # ==========================================
    # 4. Linux 多分辨率系统图标部署
    # ==========================================
    if os.path.exists(res_dir):
        img.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(res_dir, "32x32.png"), "PNG")
        img.resize((64, 64), Image.Resampling.LANCZOS).save(os.path.join(res_dir, "64x64.png"), "PNG")
        img.resize((128, 128), Image.Resampling.LANCZOS).save(os.path.join(res_dir, "128x128.png"), "PNG")
        # 128x128@2x 实际为 256x256
        img.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(res_dir, "128x128@2x.png"), "PNG")
        print("✅ Linux 安装包多尺寸系统图标生成完成")

    # ==========================================
    # 5. 客户端内部横版 UI Logo 生成 (非常关键，去官方字样)
    # ==========================================
    assets_dir = os.path.join(target_dir, "flutter", "assets")
    if os.path.exists(assets_dir):
        # 1. 部署矢量 icon.svg
        # (注：由于 base64 输入为 PNG，此处复制一个备份或跳过 svg。如果有 svg 输入则复制 svg)
        
        # 2. 合成 300x60 横版 UI 标志 (包含图标 + 文字 AppName)
        logo_canvas = Image.new("RGBA", (300, 60), (0, 0, 0, 0))
        # 缩放图标高度至 42 像素
        icon_h = 42
        icon_w = int(img.width * (icon_h / img.height))
        resized_ui_icon = img.resize((icon_w, icon_h), Image.Resampling.LANCZOS)
        # 贴在左侧 (x=15, y=9)
        logo_canvas.paste(resized_ui_icon, (15, 9), resized_ui_icon)
        
        # 在右侧绘制应用名称 (x=72)
        draw = ImageDraw.Draw(logo_canvas)
        font_size = 20
        font = None
        # 尝试加载中文字体，如果失败则使用默认字体
        font_paths = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
            "arial.ttf",
            "msyh.ttc"
        ]
        for path in font_paths:
            try:
                font = ImageFont.truetype(path, font_size)
                break
            except IOError:
                continue
        if font is None:
            font = ImageFont.load_default()
            
        # 居中对齐绘制文本
        draw.text((72, 16), app_name, fill=(51, 51, 51, 255), font=font)
        logo_canvas.save(os.path.join(assets_dir, "logo.png"), "PNG")
        print("✅ 客户端内部横版 UI Logo (包含 App 名称文本) 合成成功")
    else:
        print(f"⏭️  未找到 flutter/assets 目录，跳过横版 UI Logo 生成")

    # ==========================================
    # 6. Android 图标及状态栏纯白通知图标部署
    # ==========================================
    android_sizes = {
        "mipmap-mdpi": (48, "24x24"),
        "mipmap-hdpi": (72, "36x36"),
        "mipmap-xhdpi": (96, "48x48"),
        "mipmap-xxhdpi": (144, "72x72"),
        "mipmap-xxxhdpi": (192, "96x96")
    }
    android_base_path = os.path.join(target_dir, "flutter", "android", "app", "src", "main", "res")
    if os.path.exists(android_base_path):
        for folder, (launcher_size, stat_size_str) in android_sizes.items():
            folder_path = os.path.join(android_base_path, folder)
            os.makedirs(folder_path, exist_ok=True)
            
            # 1. 缩放生成桌面启动器图标
            resized_launcher = img.resize((launcher_size, launcher_size), Image.Resampling.LANCZOS)
            resized_launcher.save(os.path.join(folder_path, "ic_launcher.png"), "PNG")
            resized_launcher.save(os.path.join(folder_path, "ic_launcher_round.png"), "PNG")
            
            # 2. 生成 Android 状态栏纯白通知图标 (来自 logo.txt 经验)
            stat_w, stat_h = map(int, stat_size_str.split('x'))
            white_stat_icon = colorize_to_solid(img, (255, 255, 255, 255)).resize((stat_w, stat_h), Image.Resampling.LANCZOS)
            white_stat_icon.save(os.path.join(folder_path, "ic_stat_logo.png"), "PNG")
            
        print("✅ Android 安装包桌面图标与纯白状态栏通知图标部署完成")
    else:
        print(f"⏭️  未找到 Android 目录，跳过 Android 图标部署")

    # ==========================================
    # 7. macOS AppIconset 尺寸包生成
    # ==========================================
    mac_iconset_path = os.path.join(target_dir, "flutter", "macos", "Runner", "Assets.xcassets", "AppIcon.appiconset")
    if os.path.exists(mac_iconset_path):
        mac_sizes = [
            ("app_icon_16.png", 16),
            ("app_icon_32.png", 32),
            ("app_icon_64.png", 64),
            ("app_icon_128.png", 128),
            ("app_icon_256.png", 256),
            ("app_icon_512.png", 512),
            ("app_icon_1024.png", 1024)
        ]
        for filename, size in mac_sizes:
            img.resize((size, size), Image.Resampling.LANCZOS).save(os.path.join(mac_iconset_path, filename), "PNG")
        print("✅ macOS AppIconset 尺寸包生成完成")
    else:
        print(f"⏭️  未找到 macOS 资源目录，跳过 macOS 尺寸包生成")

    # 清理临时文件
    if os.path.exists(temp_png):
        os.remove(temp_png)
    print("🎉 [ALL DONE] 所有平台高级定制化图标资源已部署完毕！")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python make_icons.py <logo_base64_string> <app_name> [target_dir]")
        sys.exit(1)
        
    base64_str = sys.argv[1]
    name = sys.argv[2]
    target = sys.argv[3] if len(sys.argv) > 3 else "."
    generate_icons(base64_str, name, target)
