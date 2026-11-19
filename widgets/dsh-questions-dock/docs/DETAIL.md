# 问题挂窗

把 `C:\Users\meigu\dsh-self\questions.md` 里状态为 `open` 的问题，挂在对话框旁边。

- 点「答了」→ 我把状态改成 `answered`，这条从挂窗消失
- 点「等我想好」→ `deferred`，暂时不显示；想回答就说一声，我改回 `open`
- 点「不问了」→ `dropped`
- 挂窗每 8 秒刷新一次；文件是真源，面板只是显示

## 状态

`open` / `deferred` / `answered` / `dropped`

## 限制

- 写接口只接受本机（127.0.0.1）请求
- 面板不能替你写答案；答案请写在对话里，或者自己改文件
- 面板只显示 `open` 的条目，不显示已答的
