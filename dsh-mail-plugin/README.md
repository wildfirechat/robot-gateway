# @wildfirechat/dsh-mail

Wildfire 办公助手的 DSH 邮件工具层。

- 模型侧只暴露 `mail_*` 工具；
- 邮箱账号、IMAP 网络访问、凭据存储都由 Electron 主进程的 Mail Bridge 负责；
- 当前第一版只读：账号、文件夹、列表、搜索、读信、附件落工作区；
- 不包含发送/回复/转发；后续会在 Mail Bridge 中加入 owner 确认后的发送。

工具：

```text
mail_accounts
mail_folders
mail_list
mail_search
mail_read
mail_get_attachment
```
