package cn.wildfirechat.moltbot.moltbot.protocol;

/**
 * Moltbot Gateway Challenge响应消息
 */
public class MoltbotChallengeResponse {
    /**
     * 消息类型：固定为"challenge"
     */
    private String type = "challenge";

    /**
     * 原始nonce
     */
    private String nonce;

    /**
     * 签名（如果使用token认证）
     */
    private String signature;

    public MoltbotChallengeResponse() {
    }

    public MoltbotChallengeResponse(String nonce) {
        this.nonce = nonce;
    }

    public MoltbotChallengeResponse(String nonce, String signature) {
        this.nonce = nonce;
        this.signature = signature;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getNonce() {
        return nonce;
    }

    public void setNonce(String nonce) {
        this.nonce = nonce;
    }

    public String getSignature() {
        return signature;
    }

    public void setSignature(String signature) {
        this.signature = signature;
    }
}
