package cn.wildfirechat.openclaw.config;

import cn.wildfirechat.openclaw.core.OpenclawBridge;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/**
 * 健康检查指示器
 * 集成到Spring Boot Actuator
 */
@Component
public class OpenclawHealthIndicator implements HealthIndicator {

    @Autowired
    private OpenclawBridge bridge;

    @Override
    public Health health() {
        if (bridge.isRunning() && bridge.isWildfireConnected() && bridge.isOpenclawConnected()) {
            return Health.up()
                    .withDetail("wildfire", "connected")
                    .withDetail("openclaw", "connected")
                    .withDetail("bridge", "running")
                    .build();
        } else {
            return Health.down()
                    .withDetail("wildfire", bridge.isWildfireConnected() ? "connected" : "disconnected")
                    .withDetail("openclaw", bridge.isOpenclawConnected() ? "connected" : "disconnected")
                    .withDetail("bridge", bridge.isRunning() ? "running" : "stopped")
                    .build();
        }
    }
}
