import os
import sys
import base64
from PIL import Image, ImageDraw, ImageFont

def colorize_to_solid(img, color=(255, 255, 255, 255)):
    # Colorize non-transparent areas of a transparent PNG to solid color
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    r, g, b, a = img.split()
    solid_img = Image.new("RGBA", img.size, color)
    return Image.composite(solid_img, Image.new("RGBA", img.size, (0, 0, 0, 0)), a)

def generate_icons(logo_base64_str, app_name, target_dir="."):
    # Read from file if the path exists to bypass Windows command length limits
    if os.path.exists(logo_base64_str):
        print(f"Info: Reading base64 string from file: {logo_base64_str}")
        try:
            with open(logo_base64_str, "r", encoding="utf-8") as f:
                logo_base64_str = f.read().strip()
        except Exception as e:
            print(f"Error: Failed to read base64 file: {e}")

    # Safety check for empty or blank logo input
    if not logo_base64_str or not logo_base64_str.strip():
        print("Skip: No custom logo or icon base64 provided. Keeping default icons.")
        return

    # 1. Decode Base64 to temporary PNG file
    logo_data = base64.b64decode(logo_base64_str)
    temp_png = os.path.join(target_dir, "temp_logo_source.png")
    with open(temp_png, "wb") as f:
        f.write(logo_data)

    img = Image.open(temp_png)
    if img.mode != 'RGBA':
        img = img.convert('RGBA')

    print(f"Info: Starting multi-platform icon generation (App Name: {app_name})...")

    # ==========================================
    # 1. General asset templates and macOS launcher master
    # ==========================================
    res_dir = os.path.join(target_dir, "res")
    if os.path.exists(res_dir):
        img.save(os.path.join(res_dir, "icon.png"), "PNG")
        
        mac_icon_large = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        resized_85 = img.resize((870, 870), Image.Resampling.LANCZOS)
        mac_icon_large.paste(resized_85, (77, 77))
        mac_icon_large.save(os.path.join(res_dir, "mac-icon.png"), "PNG")
        print("Success: Generated general asset templates and macOS launcher master icons.")
    else:
        print("Skip: res directory not found, skipping master template generation.")

    # ==========================================
    # 2. Windows app and tray icons (.ico)
    # ==========================================
    win_res_dir = os.path.join(target_dir, "flutter", "windows", "runner", "resources")
    if os.path.exists(win_res_dir):
        img.save(os.path.join(win_res_dir, "app_icon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (128, 128), (256, 256)])
        
        if os.path.exists(res_dir):
            img.save(os.path.join(res_dir, "icon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (128, 128), (256, 256)])
            img.save(os.path.join(res_dir, "tray-icon.ico"), format="ICO", sizes=[(16, 16), (32, 32)])
        print("Success: Generated Windows app and tray icons.")
    else:
        print("Skip: Windows runner resource directory not found.")

    # ==========================================
    # 3. macOS Tray light and dark icons
    # ==========================================
    if os.path.exists(res_dir):
        mac_tray_dark = colorize_to_solid(img, (255, 255, 255, 255)).resize((32, 32), Image.Resampling.LANCZOS)
        mac_tray_dark.save(os.path.join(res_dir, "mac-tray-dark-x2.png"), "PNG")
        
        mac_tray_light = colorize_to_solid(img, (0, 0, 0, 255)).resize((32, 32), Image.Resampling.LANCZOS)
        mac_tray_light.save(os.path.join(res_dir, "mac-tray-light-x2.png"), "PNG")
        print("Success: Generated macOS tray icons (light and dark).")

    # ==========================================
    # 4. Linux multi-size app icons
    # ==========================================
    if os.path.exists(res_dir):
        img.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(res_dir, "32x32.png"), "PNG")
        img.resize((64, 64), Image.Resampling.LANCZOS).save(os.path.join(res_dir, "64x64.png"), "PNG")
        img.resize((128, 128), Image.Resampling.LANCZOS).save(os.path.join(res_dir, "128x128.png"), "PNG")
        img.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(res_dir, "128x128@2x.png"), "PNG")
        print("Success: Generated Linux multi-size app icons.")

    # ==========================================
    # 5. Synthesize internal horizontal UI Logo
    # ==========================================
    assets_dir = os.path.join(target_dir, "flutter", "assets")
    if os.path.exists(assets_dir):
        # 5.1 Generate Flutter fallback UI icon (256x256 PNG)
        img.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(assets_dir, "icon.png"), "PNG")
        
        # 5.2 Synthesize horizontal UI Logo (300x60)
        logo_canvas = Image.new("RGBA", (300, 60), (0, 0, 0, 0))
        icon_h = 42
        icon_w = int(img.width * (icon_h / img.height))
        resized_ui_icon = img.resize((icon_w, icon_h), Image.Resampling.LANCZOS)
        
        layout = os.getenv("LOGO_LAYOUT", "IconLeft")
        font_size_str = os.getenv("LOGO_FONT_SIZE", "22")
        try:
            font_size = int(font_size_str)
        except ValueError:
            font_size = 22
            
        text_color_hex = os.getenv("LOGO_TEXT_COLOR", "#333333")
        if text_color_hex.startswith("#"):
            text_color_hex = text_color_hex[1:]
        if len(text_color_hex) == 6:
            text_color = (int(text_color_hex[0:2], 16), int(text_color_hex[2:4], 16), int(text_color_hex[4:6], 16), 255)
        else:
            text_color = (51, 51, 51, 255)

        if layout.lower() == "iconright":
            logo_canvas.paste(resized_ui_icon, (285 - icon_w, 9), resized_ui_icon)
            text_x = 15
        else:
            logo_canvas.paste(resized_ui_icon, (15, 9), resized_ui_icon)
            text_x = 72
            
        draw = ImageDraw.Draw(logo_canvas)
        font = None
        # Try loading system font, fallback to default font if failed
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
            
        # Draw vertically centered text
        text_w, text_h = draw.textsize(app_name, font=font) if hasattr(draw, "textsize") else (100, 20)
        draw.text((text_x, 30 - text_h // 2), app_name, fill=text_color, font=font)
        logo_canvas.save(os.path.join(assets_dir, "logo.png"), "PNG")
        print(f"Success: Synthesized internal horizontal UI Logo (Layout: {layout}, Size: {font_size}).")
    else:
        print("Skip: flutter/assets directory not found.")

    # ==========================================
    # 6. Android launcher and notification icons
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
            
            resized_launcher = img.resize((launcher_size, launcher_size), Image.Resampling.LANCZOS)
            resized_launcher.save(os.path.join(folder_path, "ic_launcher.png"), "PNG")
            resized_launcher.save(os.path.join(folder_path, "ic_launcher_round.png"), "PNG")
            
            stat_w, stat_h = map(int, stat_size_str.split('x'))
            white_stat_icon = colorize_to_solid(img, (255, 255, 255, 255)).resize((stat_w, stat_h), Image.Resampling.LANCZOS)
            white_stat_icon.save(os.path.join(folder_path, "ic_stat_logo.png"), "PNG")
            
        print("Success: Generated Android launcher and status notification icons.")
    else:
        print("Skip: Android res directory not found.")

    # ==========================================
    # 7. macOS AppIconset package generation
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
        print("Success: Generated macOS AppIconset package.")
    else:
        print("Skip: macOS Assets.xcassets directory not found.")

    # Clean up temporary file
    if os.path.exists(temp_png):
        os.remove(temp_png)
    print("All multi-platform customized icon assets generated successfully!")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python make_icons.py <logo_base64_string> <app_name> [target_dir]")
        sys.exit(1)
        
    base64_str = sys.argv[1]
    name = sys.argv[2]
    target = sys.argv[3] if len(sys.argv) > 3 else "."
    generate_icons(base64_str, name, target)
