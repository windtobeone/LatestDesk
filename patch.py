#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
项目源码全自动功能定制面板 (完美典藏版)
使用说明：请将本脚本放置在项目的 Git 源码根目录下运行。
核心特性：数据解耦、脏空格清洗、LF/CRLF自适应、编码免疫、底层Git错误透视。
"""

import os
import subprocess
import sys
import time

PATCH_DIR = "patches"

# ====================================================================
# 1. 外部补丁文件动态扫描引擎
# ====================================================================
def scan_patches():
    """全自动热扫描 patches 目录，解析并构建菜单映射表"""
    patches_map = {}
    if not os.path.exists(PATCH_DIR):
        os.makedirs(PATCH_DIR)
        return patches_map
        
    for filename in os.listdir(PATCH_DIR):
        if filename.endswith(".patch"):
            base_name = filename[:-6]
            if "_" in base_name:
                parts = base_name.split("_", 1)
                idx = parts[0].strip()
                name = parts[1].strip()
            else:
                idx = str(len(patches_map) + 1)
                name = base_name
                
            file_path = os.path.join(PATCH_DIR, filename)
            patches_map[idx] = {
                "name": name,
                "file_path": file_path,
                "status": "探测中",
                "error": ""
            }
    return patches_map

# ====================================================================
# 2. Git 补丁底层核心调度引擎
# ====================================================================
def run_git_command(file_path, check_only=False, reverse=False):
    """
    【底驱动核心】强行清洗脏空格，自适应补齐末尾换行，调用系统 Git 执行安全操作
    """
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            patch_content = f.read()
    except Exception as e:
        return False, f"读取失败: {str(e)}"

    # 1. 清洗网页 \xa0 脏空格
    patch_content = patch_content.replace("\xa0", " ")
    
    # 2. 换行符智能探测与统一
    detected_newline = "\r\n" if "\r\n" in patch_content else "\n"
    
    # 3. 自动补齐文件末尾缺失的换行符
    if patch_content and not patch_content.endswith(detected_newline):
        patch_content += detected_newline
    
    temp_file = "_sanitized_patch.patch"
    with open(temp_file, "w", encoding="utf-8", newline=detected_newline) as f:
        f.write(patch_content)
        
    cmd = ["git", "apply", "--recount", "--ignore-whitespace", "--whitespace=nowarn"]
    if check_only:
        cmd.append("--check")
    if reverse:
        cmd.append("-R")
    cmd.append(temp_file)
    
    # 🛠️ 优化点 1：加入 errors="replace"，彻底免疫 Windows 终端中文 GBK/UTF-8 解析崩溃
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace")
    
    if os.path.exists(temp_file):
        os.remove(temp_file)
        
    return result.returncode == 0, result.stderr

def check_patch_status(file_path):
    """【智能状态判定】探测正反向状态，并剥离出真实的 Git 报错信息"""
    success_forward, err_f = run_git_command(file_path, check_only=True, reverse=False)
    if success_forward:
        return "未启用", ""
        
    success_reverse, err_r = run_git_command(file_path, check_only=True, reverse=True)
    if success_reverse:
        return "已启用", ""
        
    clean_error = err_f.replace("_sanitized_patch.patch", os.path.basename(file_path)).strip()
    return "冲突/已被修改", clean_error

# ====================================================================
# 3. 互动式交互菜单主循环
# ====================================================================
def main():
    if not os.path.exists(".git"):
        print("❌ 严重错误：未检测到 .git 环境！请确保将脚本放在项目的 Git 源码根目录下运行。")
        sys.exit(1)

    while True:
        patches_map = scan_patches()
        conflict_errors = []
        
        os.system('cls' if os.name == 'nt' else 'clear')
        print("=" * 78)
        print("                 项目源码全自动定制 (完美典藏版)")
        print("=" * 78)
        
        if not patches_map:
            print(f"  ⚠️  当前 [ {PATCH_DIR}/ ] 目录下空空如也，未检测到任何 .patch 文件！")
        else:
            for key in sorted(patches_map.keys(), key=lambda x: int(x) if x.isdigit() else 999):
                status, err_msg = check_patch_status(patches_map[key]["file_path"])
                patches_map[key]["status"] = status
                
                if status == "冲突/已被修改" and err_msg:
                    conflict_errors.append((key, patches_map[key]["name"], err_msg))
                
                status_str = "[已启用 / Active ]" if status == "已启用" else "[未启用 / Standby]" if status == "未启用" else f"[{status}]"
                print(f"  [{key}] {status_str} {patches_map[key]['name']}")
                
        print("-" * 78)
        if patches_map:
            print("  [A] 一键全选：自动批量打入所有处于 [未启用] 状态的功能")
            print("  [R] 一键重置：自动批量反向擦除所有已启用的功能")
        print("  [Q] 退出控制面板")
        print("=" * 78)
        
        if conflict_errors:
            print("\n🚨 【底层 Git 报错详细透视】(供排查参考)")
            for idx, name, err in conflict_errors:
                print(f"  ❌ 选项 [{idx}] 报错:\n     {err}")
            print("=" * 78)
            
        choice = input("请输入选项序号进行切换: ").strip().upper()
        
        if choice == 'Q':
            print("\n[+] 控制面板已安全关闭。")
            break
            
        elif choice == 'R' and patches_map:
            print("\n[!] 正在反向撤销...")
            for key in patches_map:
                if patches_map[key].get("status") == "已启用":
                    run_git_command(patches_map[key]["file_path"], check_only=False, reverse=True)
            print("✨ 撤销完毕！"); time.sleep(1)
            
        elif choice == 'A' and patches_map:
            print("\n[+] 正在批量注入...")
            for key in patches_map:
                if patches_map[key].get("status") == "未启用":
                    run_git_command(patches_map[key]["file_path"], check_only=False, reverse=False)
            print("✨ 注入成功！"); time.sleep(1)
            
        elif choice in patches_map:
            current_status = patches_map[choice].get("status")
            file_path = patches_map[choice]["file_path"]
            
            # 🛠️ 优化点 2：修复静默失败，精准捕获单项执行时的成功与失败反馈
            if current_status == "已启用":
                success, err = run_git_command(file_path, check_only=False, reverse=True)
                if success:
                    print("\n✨ 撤销成功！"); time.sleep(0.5)
                else:
                    print(f"\n❌ 撤销失败:\n{err}"); input("\n按回车键返回...")
                    
            elif current_status == "未启用":
                success, err = run_git_command(file_path, check_only=False, reverse=False)
                if success:
                    print("\n✨ 注入成功！"); time.sleep(0.5)
                else:
                    print(f"\n❌ 注入失败:\n{err}"); input("\n按回车键返回...")
                    
            else:
                print("\n⚠️ 该补丁有冲突，请查看菜单下方的报错信息。")
                input("\n按回车键返回...")
        else:
            time.sleep(0.5)

if __name__ == "__main__":
    main()