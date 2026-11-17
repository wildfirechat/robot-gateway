/**
 * ASR（语音转文字）提示词。
 *
 * 语音消息先经 ASR 转成文字再交给模型；识别结果常有同音字、专有名词、断句
 * 错误。这里给模型一段显式提示：说明来源、要求结合上下文静默纠正、危险操作
 * 不确定时先确认——而不是额外再调一次模型做“纠正后处理”（多一次往返且并不
 * 比主模型结合上下文更准）。
 */

/** 有转写结果时的前缀（放在用户消息正文之前，只在本条语音消息上出现一次）。 */
export const ASR_TRANSCRIPT_HINT = [
  "[语音消息 · ASR 识别] 下面这条用户消息来自语音，文字由语音识别（ASR）得到，",
  "可能有同音字、专有名词或断句错误。",
  "请结合上下文静默纠正后再理解和执行，不要在回复里复述纠正过程；",
  "若关键信息仍不确定且会影响操作结果（删除文件、发送消息、执行命令等），先简短确认再执行。",
].join("");

/** ASR 调用失败/无结果时的前缀：避免模型凭空猜测语音内容。 */
export const ASR_FAILED_HINT = [
  "[语音消息] 用户发来一条语音，但语音转文字失败（没有拿到文字内容）。",
  "请结合附件/上下文处理；无法确定内容时先向用户确认，不要猜测。",
].join("");

export interface AsrHintOptions {
  /** ASR 转写结果（非空才按“成功”处理）。 */
  transcript?: string;
  /** 是否尝试过 ASR（配置了服务地址且是语音消息）。 */
  attempted: boolean;
}

/** 按 ASR 状态给用户消息正文加提示前缀；非语音消息原样返回。 */
export function applyAsrHint(bodyText: string, options: AsrHintOptions): string {
  const text = String(bodyText ?? "");
  const transcript = typeof options?.transcript === "string" ? options.transcript.trim() : "";
  if (transcript) return `${ASR_TRANSCRIPT_HINT}\n\n${text}`;
  if (options?.attempted) return `${ASR_FAILED_HINT}\n\n${text}`;
  return text;
}
