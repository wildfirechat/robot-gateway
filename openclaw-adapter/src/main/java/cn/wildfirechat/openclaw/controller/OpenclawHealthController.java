package cn.wildfirechat.openclaw.controller;

import cn.wildfirechat.openclaw.core.OpenclawBridge;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.Map;

/**
 * Openclaw适配器状态监控接口
 */
@RestController
@RequestMapping("/openclaw")
public class OpenclawHealthController {

    @Autowired
    private OpenclawBridge bridge;

    /**
     * 健康检查接口
     * GET /actuator/health 会自动调用这个
     */
    @GetMapping("/status")
    public Map<String, Object> getStatus() {
        Map<String, Object> status = new HashMap<>();

        Map<String, Object> wildfire = new HashMap<>();
        wildfire.put("connected", bridge.isWildfireConnected());
        wildfire.put("status", bridge.isWildfireConnected() ? "UP" : "DOWN");

        Map<String, Object> openclaw = new HashMap<>();
        openclaw.put("connected", bridge.isOpenclawConnected());
        openclaw.put("status", bridge.isOpenclawConnected() ? "UP" : "DOWN");

        status.put("wildfire", wildfire);
        status.put("openclaw", openclaw);
        status.put("bridge", bridge.isRunning() ? "RUNNING" : "STOPPED");

        return status;
    }

    /**
     * 测试接口
     * GET /openclaw/test
     */
    @GetMapping("/test")
    public Map<String, String> test() {
        Map<String, String> result = new HashMap<>();
        result.put("message", "Openclaw Adapter is running");
        result.put("wildfire", bridge.isWildfireConnected() ? "Connected" : "Disconnected");
        result.put("openclaw", bridge.isOpenclawConnected() ? "Connected" : "Disconnected");
        return result;
    }
}
