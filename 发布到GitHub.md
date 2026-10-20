# 首次发布到 GitHub

已选择的许可证为 GPL-3.0-only。建议仓库名为 `pdf-whiteboard`，也可以使用其他名称。

## 1. 新建自己的仓库

1. 登录 GitHub，点击右上角 `+` → `New repository`。
2. Repository name 填 `pdf-whiteboard`。
3. Description 可填：`离线 PDF 批注与逐步展示白板，支持备课步骤和临时随堂笔记。`
4. Visibility 选 `Public`。
5. 不勾选自动添加 README、.gitignore 或 License：本地已准备了这些文件。
6. 点击 `Create repository`，保留仓库页面的链接。

这是新建自己的项目，不需要 Fork 别人的仓库。也不需要先购买域名或开启 GitHub Pages。

## 2. 最简单的上传方式：网页上传

1. 使用整理好的干净发布文件夹；也可在安装依赖后运行 `npm run package` 重新生成。
2. 如果拿到的是压缩包，先解压，找到里面的 `github-upload-*` 文件夹。
3. 在新仓库点击 `uploading an existing file` 或 `Add file` → `Upload files`。
4. 将干净文件夹**里面的文件和子文件夹**拖入页面，避免额外嵌套一层目录。
5. 提交说明可填 `Initial release`，点击 `Commit changes`。
6. 检查仓库根目录能看到 `README.md`、`LICENSE`、`app.mjs` 和 `PDF课堂白板.html`。

不要只上传一个 ZIP，也不要拖入当前工作目录的 `data/` 或整个电脑工作区。`.gitignore` 不会替网页上传自动过滤文件，因此请使用干净发布文件夹。

网页上传若遗漏以点开头的文件或 `.github/` 文件夹，可以改用下面的 Git 方式补齐；不影响下载 HTML 使用，但应保留 `.gitignore` 和自动检查配置。

## 3. 后续更新更方便的方式：Git

在项目目录打开 PowerShell。首次提交前，在 GitHub Settings → Emails 确认提交邮箱；如需隐藏私人邮箱，可使用 GitHub 提供的 noreply 邮箱。

```powershell
git init -b main
git config user.name "你的GitHub显示名"
git config user.email "你的GitHub提交邮箱或noreply邮箱"
git add .
git status
git commit -m "Initial release"
git remote add origin https://github.com/你的用户名/pdf-whiteboard.git
git push -u origin main
```

命令中的显示名、邮箱和仓库地址需自行替换。如果本地仓库已初始化，跳过 `git init`。提交前确认 `git status` 不包含教材、音频或私人笔记。

登录授权按 Git 弹出的官方流程完成，无需把 GitHub 密码、Token 或恢复码交给他人。GitHub 不接受账号密码作为 HTTPS Git 推送密码。

如果你已用网页提交过文件，请先克隆该仓库，再将更新文件复制进去后提交；不要用强制推送覆盖已有提交。

## 4. 发布可下载的版本

代码上传后，在仓库右侧 `Releases` → `Draft a new release`：

- 标签：`v0.1.0`。
- 标题：`v0.1.0 - 首个公开版本`。
- 说明：列出 PDF 批注、步骤展示、临时随堂笔记和音频等功能。
- 附件：干净发布文件夹的 ZIP，或同时提供 HTML 与许可证文件。

若分发修改过的 GPL 版本，应保留许可证并提供该版本对应的源码。建议每个 Release 对应一个源码标签。

## 5. 需要保留和排除的内容

应公开：项目源码、构建脚本、README、使用说明、测试、GPL 许可证、PDF.js 许可证及第三方声明。生成的离线 HTML 也已包含在发布文件中。

不应随本项目公开：商业教材 PDF、配套音频、个人笔记备份、`.env`、凭证、`node_modules/` 和本地测试输出。项目的 `data/` 已被忽略，打包脚本还会按白名单再次过滤。

目前无需开启 GitHub Pages。先保证仓库能下载使用，再根据需要增加在线演示和截图。公开示例或截图请使用自己制作或有权再分发的材料。
