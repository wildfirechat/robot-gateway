# @wildfirechat/dsh-pdf

纯 JS 的 DSH PDF 工具插件，随 Wildfire 桌面端的 DSH profile 默认分发。

## 能力

- `pdf_info`：页数、页面尺寸、元数据、文字层探测
- `pdf_extract_text`：按页/页区间提取文本，保留简单阅读顺序
- `pdf_extract_tables`：从有文字层的 PDF 提取简单 Markdown 表格
- `pdf_merge` / `pdf_split` / `pdf_extract_pages` / `pdf_delete_pages`
- `pdf_rotate` / `pdf_reorder`
- `pdf_watermark`：文字水印（中文建议传 `.ttf` 的 `font_path`）
- `pdf_form_fields` / `pdf_fill_form`：AcroForm 文本域/复选框

## 设计说明

- 读取通过 DSH 的 `ctx.fs`（`resolve` / `stat` / `readBytes`）。
- DSH 0.2.2 的 `ctx.fs` 只暴露 `writeText`，没有二进制 `writeBytes`；
  PDF 输出先通过 `ctx.fs.resolve` 授权路径，再调用宿主 `fs.writeFile`。
  插件会自行拒绝 workspace 之外的输出路径，但这一步不经过 `fs-sandbox`
  的写入策略，部署时需把它视为受信任的本机插件。
- 不包含 OCR；扫描件应使用 `office_render` 渲染后由视觉模型阅读。
- 加密 PDF 只支持读取时传 `password`；`pdf-lib` 不支持加密输出。
- `pdf_extract_tables` 只做坐标聚类，复杂合并单元格不保证。
- 水印 TTC 不支持；Windows 自动探测 simhei/msyh，macOS 自动探测
  Arial Unicode.ttf，其他情况请传 `.ttf` 的 `font_path`。

## 构建/分发

当前项目通过 `scripts/sync-pdf-plugin.js` 把本包 `src` 和最小依赖集合
（pdf-lib / @pdf-lib/fontkit / pdfjs-dist 的 Node ESM 入口、cmaps、字体）
同步到 `build/dsh-profile-template`，并写入 profile patch，默认加载。
