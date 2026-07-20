# Windows Local Build Script for Customized Flutter Client (Option 1 Hybrid)
# =========================================================================
# This script automates the complete customization, compilation, and packaging
# process locally on your Windows machine, mirroring the GitHub Actions workflow.
# Ensure you run this script in PowerShell as Administrator or with appropriate privileges.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = "Stop"

# ==========================================
# Part 1: Custom Client Customization Settings
# ==========================================
# Feel free to modify these settings to match your desired branding.
$NEW_APP_NAME = "D222222"                              # Display name in Windows GUI and Printer List
$NEW_EXE_NAME = "D222222.exe"                          # Name of the final single packer executable
$NEW_PREFIX   = "d222222"                              # Service name / folder prefix (lowercase, no spaces)
$NEW_EMAIL    = "wind.ex@qq.com"                        # Maintainer email
$NEW_IP       = "192.168.201.129"                       # Rendezvous relay server host IP
$NEW_PUB_KEY  = "4Z9UuzUy2tVgRWqyPJ84813O7AgP0yhzg9wE3g7Kk9I=" # Rendezvous server public key
$NEW_API_SERVER = "http://192.168.201.129"              # Preconfigured API server URL
$APPLY_PATCHES = "09"                                  # Comma-separated patch IDs to apply

# The custom.txt payload configuration (Base64 cryptographically signed custom config payload)
$CUSTOM_TXT_CONTENT = "hPvaMFqdjnOl7nXuAIr2n3XqiBMiQHh4jmVMTir6Q8iCP8xnLiMUKalYbxN6H5p7x27jCtpc7nxXCvEGDDzvCnsKICAiYXBpLXNlcnZlciI6ICJodHRwOi8vMTkyLjE2OC4yMDEuMTI5IiwKICAiYXBwLW5hbWUiOiAiRDIyMjIyMiIsCiAgImN1c3RvbS1yZW5kZXp2b3VzLXNlcnZlciI6ICIxOTIuMTY4LjIwMS4xMjkiLAogICJoYmJzIjogIjE5Mi4xNjguMjAxLjEyOSIsCiAgImtleSI6ICI0WjlVdXpVeTJ0VmdSV3F5UEo4NDgxM083QWdQMHloemc5d0UzZzdLazlJPSIsCiAgIm9wZW5zc2wtY2hlY2siOiAiWSIKfQ=="

# Set environment variables for oneKey.py customization script
$env:NEW_APP_NAME = $NEW_APP_NAME
$env:NEW_EXE_NAME = $NEW_EXE_NAME
$env:NEW_PREFIX   = $NEW_PREFIX
$env:NEW_EMAIL    = $NEW_EMAIL
$env:NEW_IP       = $NEW_IP
$env:NEW_PUB_KEY  = $NEW_PUB_KEY
$env:NEW_API_SERVER = $NEW_API_SERVER
$env:CUSTOM_TXT_BASE64 = $CUSTOM_TXT_CONTENT
$env:APPLY_PATCHES = $APPLY_PATCHES

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Starting Local Build for: $NEW_APP_NAME ($NEW_EXE_NAME)" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

# ==========================================
# Part 2: Preparing Assets
# ==========================================
Write-Host "[1/7] Preparing icons and assets..." -ForegroundColor Cyan

# Generate a dummy 1x1 transparent PNG base64 string if logo_base64.txt is missing
if (-not (Test-Path "logo_base64.txt")) {
    Write-Host "logo_base64.txt not found. Generating a default placeholder icon..." -ForegroundColor Yellow
    # 1x1 transparent pixel base64
    $dummy_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    Set-Content -Path "logo_base64.txt" -Value $dummy_b64
}

# Run make_icons.py to generate target app icon resources
python make_icons.py logo_base64.txt $NEW_APP_NAME

# ==========================================
# Part 3: Applying Customization & Patches
# ==========================================
Write-Host "[2/7] Running customization script and applying patches..." -ForegroundColor Cyan

# First, reset any modified files to avoid patch application conflicts
Write-Host "Resetting git changes to start from a clean state..." -ForegroundColor Yellow
git reset --hard
git checkout feat-t2u-udp-relay

# Inject custom verification key for local testing config
Write-Host "Injecting custom verification public key..." -ForegroundColor Yellow
(Get-Content "src/common.rs") -replace '5Qbwsde3unUcJBtrx9ZkvUmwFNoExHzpryHuPUdqlWM=', 'EC1tAyzTzn24OFr2gN3lPQfgqH2jzwA5l+gEl43+d2s=' | Set-Content "src/common.rs"

python oneKey.py

# ==========================================
# Part 4: Compiling Rust & Flutter
# ==========================================
Write-Host "[3/7] Compiling Flutter & Rust Windows binaries..." -ForegroundColor Cyan
python build.py --portable --flutter --skip-portable-pack --hwcodec --vram

# ==========================================
# Part 5: Preparing the Release Folder
# ==========================================
Write-Host "[4/7] Preparing Release_Flutter directory..." -ForegroundColor Cyan
if (Test-Path "Release_Flutter") {
    Remove-Item -Path "Release_Flutter" -Recurse -Force
}
New-Item -ItemType Directory -Path "Release_Flutter" | Out-Null

# Copy build outputs from runner/Release
Copy-Item -Path "flutter/build/windows/x64/runner/Release/*" -Destination "Release_Flutter" -Recurse -Force
# Rename the main executable
Rename-Item -Path "Release_Flutter/rustdesk.exe" -NewName $NEW_EXE_NAME

# ==========================================
# Part 6: Fetching Drivers & Dependencies
# ==========================================
Write-Host "[5/7] Downloading virtual display and printer drivers..." -ForegroundColor Cyan

# Download usbmmidd_v2 (Virtual Display Driver)
if (-not (Test-Path "usbmmidd_v2.zip")) {
    Write-Host "Downloading usbmmidd_v2.zip..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "https://github.com/rustdesk-org/rdev/releases/download/usbmmidd_v2/usbmmidd_v2.zip" -OutFile "usbmmidd_v2.zip"
}
Expand-Archive -Path "usbmmidd_v2.zip" -DestinationPath "Release_Flutter" -Force
if (Test-Path "Release_Flutter/usbmmidd_v2/Win32") {
    Remove-Item -Path "Release_Flutter/usbmmidd_v2/Win32" -Recurse -Force
}
# Clean unused loader executables to keep size small
foreach ($file in @("deviceinstaller64.exe", "deviceinstaller.exe", "usbmmidd.bat")) {
    if (Test-Path "Release_Flutter/$file") {
        Remove-Item -Path "Release_Flutter/$file" -Force
    }
}

# Download printer drivers and adapter dll
if (-not (Test-Path "rustdesk_printer_driver_v4-1.4.zip")) {
    Write-Host "Downloading printer driver..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "https://github.com/rustdesk/hbb_common/releases/download/driver/rustdesk_printer_driver_v4-1.4.zip" -OutFile "rustdesk_printer_driver_v4-1.4.zip"
}
if (-not (Test-Path "printer_driver_adapter.zip")) {
    Write-Host "Downloading printer driver adapter DLL..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "https://github.com/rustdesk/hbb_common/releases/download/driver/printer_driver_adapter.zip" -OutFile "printer_driver_adapter.zip"
}

# Extract printer driver
Expand-Archive -Path "rustdesk_printer_driver_v4-1.4.zip" -DestinationPath "." -Force
New-Item -ItemType Directory -Path "Release_Flutter/drivers" -Force | Out-Null
if (Test-Path "Release_Flutter/drivers/RustDeskPrinterDriver") {
    Remove-Item -Path "Release_Flutter/drivers/RustDeskPrinterDriver" -Recurse -Force
}
Move-Item -Path "rustdesk_printer_driver_v4-1.4" -Destination "Release_Flutter/drivers/RustDeskPrinterDriver" -Force

# Extract printer adapter DLL
Expand-Archive -Path "printer_driver_adapter.zip" -DestinationPath "." -Force
Move-Item -Path "printer_driver_adapter.dll" -Destination "Release_Flutter/" -Force

# Clone and build RustDeskTempTopMostWindow (Privacy Mode dependency)
Write-Host "[6/7] Building topmost window DLL..." -ForegroundColor Cyan
if (Test-Path "RustDeskTempTopMostWindow") {
    Remove-Item -Path "RustDeskTempTopMostWindow" -Recurse -Force
}
try {
    git clone https://github.com/rustdesk-org/RustDeskTempTopMostWindow RustDeskTempTopMostWindow
    pushd RustDeskTempTopMostWindow
    git checkout 53b548a5398624f7149a382000397993542ad796
    # Try compiling with msbuild if available
    if (Get-Command msbuild -ErrorAction SilentlyContinue) {
        msbuild WindowInjection/WindowInjection.vcxproj -p:Configuration=Release -p:Platform=x64 /p:TargetVersion=Windows10
        popd
        Copy-Item -Path "RustDeskTempTopMostWindow/WindowInjection/x64/Release/WindowInjection.dll" -Destination "Release_Flutter/WindowInjection.dll" -Force
        Write-Host "Success: Built and copied WindowInjection.dll successfully" -ForegroundColor Green
    } else {
        popd
        Write-Host "Warning: msbuild not found in PATH, skipping building WindowInjection.dll (Privacy Mode will be inactive but client will run fine)." -ForegroundColor Yellow
    }
} catch {
    Write-Host "Warning: Failed to compile topmost window dependency. Skipping..." -ForegroundColor Yellow
}

# ==========================================
# Part 7: Packaging Single EXE
# ==========================================
Write-Host "[7/7] Packaging files into a single portable EXE..." -ForegroundColor Cyan

# Strip dpiAware from manifest to prevent scaling issues on packer extraction
if (Test-Path "res/manifest.xml") {
    (Get-Content "res/manifest.xml") -replace '<dpiAware[^>]*>[^<]*</dpiAware>', '' | Set-Content "res/manifest.xml"
}

# Copy custom.txt to release folder
Copy-Item -Path "src/custom.txt" -Destination "Release_Flutter/custom.txt" -Force

# Execute packer generator
pushd libs/portable
python3 -m pip install -r requirements.txt --quiet
python3 ./generate.py -f ../../Release_Flutter/ -o . -e ../../Release_Flutter/$NEW_EXE_NAME
popd

# Output final binary
if (-not (Test-Path "dist")) {
    New-Item -ItemType Directory -Path "dist" | Out-Null
}
Copy-Item -Path "target/release/rustdesk-portable-packer.exe" -Destination "dist/$NEW_EXE_NAME" -Force

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Build Completed Successfully!" -ForegroundColor Green
Write-Host "Your customized single executable is located at: dist/$NEW_EXE_NAME" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
