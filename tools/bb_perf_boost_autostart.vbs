Set shell = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\Fran\Desktop\BOT BB\tools\bb_perf_boost_daemon.ps1"""
shell.Run cmd, 0, False
