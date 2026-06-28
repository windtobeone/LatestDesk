import os
import base64
import subprocess

# ==========================================
# Part 1: Global customization parameters (Read from GitHub Actions environment)
# ==========================================
NEW_APP_NAME = os.getenv("NEW_APP_NAME", "QQanDesk")
NEW_EXE_NAME = os.getenv("NEW_EXE_NAME", "QQnDesk.exe")
NEW_PREFIX   = os.getenv("NEW_PREFIX", "QQndesk")
NEW_DOMAIN   = os.getenv("NEW_DOMAIN", "wind.ex.com")
NEW_URL      = os.getenv("NEW_URL", f"https://{NEW_DOMAIN}")
NEW_EMAIL    = os.getenv("NEW_EMAIL", "wind.ex@qq.com")
NEW_IP       = os.getenv("NEW_IP", "192.168.201.129")
NEW_PUB_KEY  = os.getenv("NEW_PUB_KEY", "4Z9UuzUy2tVgRWqyPJ84813O7AgP0yhzg9wE3g7Kk9I=")

# ==========================================
# Extracted multi-line code blocks for replacement
# ==========================================
OLD_LOAD_POWERED = """Widget loadPowered(BuildContext context) {
  if (bind.mainGetBuildinOption(key: "hide-powered-by-me") == 'Y') {
    return SizedBox.shrink();
  }
  return MouseRegion(
    cursor: SystemMouseCursors.click,
    child: GestureDetector(
      onTap: () {
        launchUrl(Uri.parse('https://rustdesk.com'));
      },
      child: Opacity(
          opacity: 0.5,
          child: Text(
            translate("powered_by_me"),
            overflow: TextOverflow.clip,
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(fontSize: 9, decoration: TextDecoration.underline),
          )),
    ),
  ).marginOnly(top: 6);
}"""

NEW_LOAD_POWERED = """Widget loadPowered(BuildContext context) {
  return const SizedBox.shrink();
}"""

OLD_TAB_TEXT = """child: const Text(
                              "RustDesk",
                              style: TextStyle(fontSize: 13),
                            )"""

NEW_TAB_TEXT = """child: Text(
                              bind.mainGetAppNameSync(),
                              style: const TextStyle(fontSize: 13),
                            )"""

# ==========================================
# Part 2: Replacement rules mapping
# ==========================================
REPLACEMENTS = {
    "Cargo.toml": [
        ('Copyright © 2025 Purslane Ltd.', f'Copyright © 2025 {NEW_DOMAIN}.'),
        ('ProductName = "RustDesk"', f'ProductName = "{NEW_APP_NAME}"'),
        ('FileDescription = "RustDesk Remote Desktop"', f'FileDescription = "{NEW_APP_NAME} Remote Desktop"'),
        ('OriginalFilename = "rustdesk.exe"', f'OriginalFilename = "{NEW_EXE_NAME}"'),
        ('name = "RustDesk"', f'name = "{NEW_APP_NAME}"')
    ],
    "build.py": [
        ('rustdesk.exe', NEW_EXE_NAME),
        ('rustdesk_portable.exe', f'{NEW_PREFIX}_portable.exe'),
        ('rustdesk-{version}-install.exe', f'{NEW_PREFIX}-{{version}}-install.exe'),
        ('target\\release\\rustdesk.exe', f'target\\release\\{NEW_EXE_NAME}'),
        ('target/release/rustdesk.exe', f'target/release/{NEW_EXE_NAME}')
    ],
    "flutter/lib/common.dart": [
        (OLD_LOAD_POWERED, NEW_LOAD_POWERED),
        ('https://rustdesk.com', NEW_URL)
    ],
    "flutter/lib/desktop/pages/connection_page.dart": [
        ('https://rustdesk.com/pricing', NEW_URL)
    ],
    "flutter/lib/desktop/pages/desktop_home_page.dart": [
        ('https://rustdesk.com/download', NEW_URL),
        ('https://rustdesk.com/docs/en/client/linux/#permissions-issue', NEW_URL),
        ('https://rustdesk.com/docs/en/client/linux/#x11-required', NEW_URL),
        ('https://rustdesk.com/docs/en/client/linux/#login-screen', NEW_URL)
    ],
    "flutter/lib/desktop/pages/desktop_setting_page.dart": [
        ('https://rustdesk.com/privacy.html', NEW_URL),
        ('https://rustdesk.com', NEW_URL)
    ],
    "flutter/lib/desktop/pages/install_page.dart": [
        ('https://rustdesk.com/privacy.html', NEW_URL)
    ],
    "flutter/lib/desktop/widgets/tabbar_widget.dart": [
        (OLD_TAB_TEXT, NEW_TAB_TEXT)
    ],
    "flutter/lib/mobile/pages/connection_page.dart": [
        ('https://rustdesk.com/download', NEW_URL)
    ],
    "flutter/lib/mobile/pages/settings_page.dart": [
        ('https://rustdesk.com/privacy.html', f'{NEW_URL}/privacy.html'),
        ('https://rustdesk.com/', f'{NEW_URL}/'),
        ("'rustdesk.com'", f"'{NEW_DOMAIN}'")
    ],
    "flutter/windows/CMakeLists.txt": [
        ('project(rustdesk LANGUAGES CXX)', f'project({NEW_APP_NAME} LANGUAGES CXX)'),
        ('set(BINARY_NAME "rustdesk")', f'set(BINARY_NAME "{NEW_APP_NAME}")')
    ],
    "flutter/windows/runner/Runner.rc": [
        ('"CompanyName", "Purslane Ltd"', f'"CompanyName", "{NEW_DOMAIN}"'),
        ('"FileDescription", "RustDesk Remote Desktop"', f'"FileDescription", "{NEW_APP_NAME} Remote Desktop"'),
        ('"InternalName", "rustdesk"', f'"InternalName", "{NEW_APP_NAME}"'),
        ('"LegalCopyright", "Copyright © 2025 Purslane Ltd. All rights reserved."', f'"LegalCopyright", "Copyright © 2025 {NEW_DOMAIN}. All rights reserved."'),
        ('"OriginalFilename", "rustdesk.exe"', f'"OriginalFilename", "{NEW_EXE_NAME}"'),
        ('"ProductName", "RustDesk"', f'"ProductName", "{NEW_APP_NAME}"')
    ],
    "libs/hbb_common/src/config.rs": [
        ('RwLock::new("RustDesk".to_owned())', f'RwLock::new("{NEW_APP_NAME}".to_owned())'),
        ('"https://rustdesk.com/docs/en/"', f'"{NEW_URL}/"'),
        ('"https://rustdesk.com/docs/en/manual/linux/#x11-required"', f'"{NEW_URL}/"'),
        ('"https://github.com/rustdesk/rustdesk/wiki/Headless-Linux-Support"', f'"{NEW_URL}/"'),
        ('&["rs-ny.rustdesk.com"]', f'&["{NEW_IP}"]'),
        ('"OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw="', f'"{NEW_PUB_KEY}"')
    ],
    "libs/hbb_common/src/lib.rs": [
        ('"https://api.rustdesk.com/version/latest"', f'"{NEW_URL}/version/latest"')
    ],
    "libs/portable/Cargo.toml": [
        ('Copyright © 2025 Purslane Ltd.', f'Copyright © 2025 {NEW_DOMAIN}.'),
        ('ProductName = "RustDesk"', f'ProductName = "{NEW_APP_NAME}"'),
        ('OriginalFilename = "rustdesk.exe"', f'OriginalFilename = "{NEW_EXE_NAME}"'),
        ('FileDescription = "RustDesk Remote Desktop"', f'FileDescription = "{NEW_APP_NAME} Remote Desktop"')
    ],
    "libs/portable/generate.py": [
        ('default is rustdesk.exe', f'default is {NEW_EXE_NAME}'),
        ("options.executable = 'rustdesk.exe'", f"options.executable = '{NEW_EXE_NAME}'")
    ],
    "libs/portable/src/main.rs": [
        ('APP_PREFIX: &str = "rustdesk"', f'APP_PREFIX: &str = "{NEW_PREFIX}"')
    ],
    "src/auth_2fa.rs": [
        ('ISSUER: &str = "RustDesk"', f'ISSUER: &str = "{NEW_APP_NAME}"')
    ],
    "src/clipboard.rs": [
        ('"RustDesk placeholder to clear the file clipboard"', f'"{NEW_APP_NAME} placeholder to clear the file clipboard"')
    ],
    "src/common.rs": [
        ('"https://admin.rustdesk.com"', f'"{NEW_URL}"'),
        ('url.contains("rustdesk.com/")', f'url.contains("{NEW_DOMAIN}/")'),
        ('url.ends_with("rustdesk.com")', f'url.ends_with("{NEW_DOMAIN}")'),
        ('is_public("https://rustdesk.com/")', f'is_public("{NEW_URL}/")'),
        ('is_public("https://www.rustdesk.com/")', f'is_public("https://www.{NEW_DOMAIN}/")'),
        ('is_public("https://api.rustdesk.com/v1")', f'is_public("https://api.{NEW_DOMAIN}/v1")'),
        ('is_public("https://API.RUSTDESK.COM/v1")', f'is_public("https://API.{NEW_DOMAIN.upper()}/v1")'),
        ('is_public("https://rustdesk.com/path")', f'is_public("{NEW_URL}/path")'),
        ('is_public("rustdesk.com")', f'is_public("{NEW_DOMAIN}")'),
        ('is_public("https://rustdesk.com")', f'is_public("{NEW_URL}")'),
        ('is_public("https://RustDesk.com")', f'is_public("https://Wind.Ex.Com")'), 
        ('is_public("http://www.rustdesk.com")', f'is_public("http://www.{NEW_DOMAIN}")'),
        ('is_public("https://api.rustdesk.com")', f'is_public("https://api.{NEW_DOMAIN}")'),
        ('is_public("https://rustdesk.computer.com")', f'is_public("https://{NEW_PREFIX}.computer.com")'),
        ('is_public("rustdesk.comhello.com")', f'is_public("{NEW_DOMAIN}hello.com")'),
        ('"https://admin.rustdesk.com/api/login"', f'"{NEW_URL}/api/login"')
    ],
    "src/lang.rs": [
        ('&& name != "powered_by_me"', ' ')
    ],
    "src/main.rs": [
        ('App::new("rustdesk")', f'App::new("{NEW_PREFIX}")'),
        ('"Purslane Ltd<info@rustdesk.com>"', f'"{NEW_EMAIL}"'),
        ('about("RustDesk command line tool")', f'about("{NEW_APP_NAME} command line tool")')
    ]
}

# ==========================================
# Part 3: Core execution logic
# ==========================================
def apply_customization():
    print(f"Info: Starting customization for target app: {NEW_APP_NAME}")
    success_count = 0
    fail_count = 0

    for filepath, rules in REPLACEMENTS.items():
        if not os.path.exists(filepath):
            print(f"Skip: File does not exist: {filepath}")
            fail_count += 1
            continue
            
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()

            original_content = content
            for old_str, new_str in rules:
                content = content.replace(old_str, new_str)
                
            if content != original_content:
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f"Success: Modified file: {filepath}")
                success_count += 1
            else:
                print(f"Skip: No modification needed for: {filepath}")
                
        except Exception as e:
            print(f"Error: Failed to modify {filepath}: {e}")
            fail_count += 1

    print("\n" + "="*35)
    print(f"Customization done! Successfully modified {success_count} files, skipped/failed {fail_count} files.")
    print("="*35)

    # ==========================================
    # Part 4: custom.txt dynamic decryption and write
    # ==========================================
    custom_txt_b64 = os.getenv("CUSTOM_TXT_BASE64", "")
    if custom_txt_b64:
        try:
            decoded = base64.b64decode(custom_txt_b64)
            os.makedirs("src", exist_ok=True)
            with open("src/custom.txt", "wb") as f:
                f.write(decoded)
            print("Success: custom.txt written successfully")
        except Exception as e:
            print(f"Error: Failed to write custom.txt: {e}")

    # ==========================================
    # Part 5: Git patch auto-injection engine
    # ==========================================
    apply_patches_str = os.getenv("APPLY_PATCHES", "")
    if apply_patches_str:
        patch_ids = [p.strip() for p in apply_patches_str.split(",") if p.strip()]
        print(f"Info: Found patches to apply: {patch_ids}")
        
        patch_dir = "patches"
        if os.path.exists(patch_dir):
            for filename in sorted(os.listdir(patch_dir)):
                if filename.endswith(".patch"):
                    parts = filename.split("_", 1)
                    if parts:
                        idx = parts[0].strip()
                        if idx in patch_ids:
                            print(f"Info: Applying patch: {filename}")
                            patch_path = os.path.join(patch_dir, filename)
                            cmd = ["git", "apply", "--recount", "--ignore-whitespace", "--whitespace=nowarn", patch_path]
                            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                            if res.returncode == 0:
                                print(f"Success: Applied patch successfully: {filename}")
                            else:
                                print(f"Error: Failed to apply patch {filename}: {res.stderr}")

if __name__ == '__main__':
    apply_customization()