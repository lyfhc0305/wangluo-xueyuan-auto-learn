# 网络学院自动学习

用于河南干部网络学院的浏览器自动学习助手。通过本机 Chrome / Edge 打开课程并播放，学习记录由网站处理。

## 快速开始

1. 安装 Node.js 22.12 或更高版本，以及 Chrome / Edge。
2. 下载本仓库或发布包并解压。
3. Windows 双击 `启动学习.bat`；macOS / Linux 在目录中执行 `bash 启动学习.sh`。
4. 在弹出的浏览器中手动登录，按页面要求完成验证码和随堂答题。

也可以在本目录运行：

```sh
npm ci
node auto-learn.mjs
```

不需要填写账号密码即可运行。若要调整目标等设置，将 `config.example.json` 复制为 `config.json` 后修改。默认目标为累计 5 学时/学分，具体限制以网站显示为准。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `node auto-learn.mjs --daily` | 持续处理课程，检测到每日限制后停止 |
| `node auto-learn.mjs --credit=5` | 设置累计目标 |
| `node auto-learn.mjs --max-courses=1` | 本次最多处理一门课 |
| `node auto-learn.mjs --list` | 列出未选课程 |
| `node auto-learn.mjs --plan` | 只计算并打印「最快攒学时」的选课顺序与预计耗时，不学习 |
| `node auto-learn.mjs --diagnose` | 输出接口状态摘要，不输出完整用户资料 |
| `node auto-learn.mjs --logout` | 退出并清理当前浏览器会话的 Cookie 和站点存储 |
| `node auto-learn.mjs --reset-profile` | 删除当前会话目录，下次需重新登录 |
| `node auto-learn.mjs --profile=account2` | 使用独立的浏览器会话和独立的学习进度文件 |
| `node auto-learn.mjs --user=手机号 --pass=密码 --daily` | 从命令行传入凭据(不写盘、不进日志),用于多账号并行 |
| `node auto-learn.mjs --no-mute` | 开启播放声音 |

选课策略为「学分 ÷ 全片时长」从大到小:短微课的学时效率约为长视频课的 3~5 倍,`--plan` 可预览当前最优顺序。已选未看完的课会按剩余进度折算并优先补完。

## 多账号并行

`.\并行学习.ps1` 可一次拉起多个账号并行学习(各自独立会话目录 `.chrome-profile-*`、进度文件 `state-*.json` 和日志)。账号写在 `accounts.local.json`(明文密码,已被 `.gitignore` 排除,请勿外传),没有该文件时会交互式询问。profile 名若为手机号,程序会自动打码(如 `138＊＊＊＊6693`)后再用于文件名和日志。

浏览器窗口应保持打开;如网站提示人工操作,请按提示处理。

## 隐私与分享

发布包不包含账号密码、登录会话或历史学习记录。运行后会生成本地数据：

- `.chrome-profile*/`：浏览器 Cookie、登录态、缓存等敏感数据，不应分享。
- `config.json`：可选配置；如果填写密码，会明文保存。建议保持账号密码为空，手动登录。
- `accounts.local.json`：并行学习用的账号密码，明文保存，已被 `.gitignore` 排除。
- `logs/`：运行日志，可能含课程、学时、电脑路径和网站错误内容，分享前需检查。
- `state.json` / `state-*.json`：本地课程处理记录，可能暴露学习情况。

分享前可运行 `node privacy-check.mjs`(或指定目录:`node privacy-check.mjs "某文件夹"`)自动扫描本文件夹的手机号、身份证号、邮箱、绝对路径等敏感内容。这些文件已被 `.gitignore` 排除；不要强制加入版本控制。诊断功能只输出选定的状态字段，但一般日志仍需人工检查。程序会向目标学院网站发起正常登录及课程请求，浏览器会在本地持久保存会话，不能将其理解为“不保存任何凭据”。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `auto-learn.mjs` | 主程序 |
| `并行学习.ps1` | 多账号并行启动器(Windows PowerShell) |
| `privacy-check.mjs` | 分享前隐私自查工具 |
| `config.example.json` | 不含凭据的配置样例 |
| `package.json` / `package-lock.json` | 依赖及版本锁定 |
| `启动学习.bat` / `启动学习.sh` | 启动入口 |
| `先读我.txt` | 简明使用说明 |

仅在本人有权使用的账号和允许的场景中使用，遵守所在单位及网站的相关要求。网站更新可能导致功能失效；本仓库不保证学习结果或学分入账。
