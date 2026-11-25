# @wildfirechat/dsh-mail

Wildfire 办公助手的 DSH 邮件工具层。

- 模型侧只暴露 `mail_*` 工具；
- 邮箱账号、IMAP 网络访问、凭据存储都由 Electron 主进程的 Mail Bridge 负责；
- 当前支持：账号、文件夹、列表/搜索（offset 翻页）、读信、附件落工作区；
- 支持发送/回复/转发，必须经过 DSH owner 一次性审批；
- 支持保存草稿（不发送）；转发时携带原附件；
- 支持标记已读/未读/星标、移动邮件。

工具：

```text
mail_accounts
mail_folders
mail_list
mail_search
mail_read
mail_get_attachment
mail_draft
mail_send
mail_reply
mail_forward
mail_mark
mail_move
```
