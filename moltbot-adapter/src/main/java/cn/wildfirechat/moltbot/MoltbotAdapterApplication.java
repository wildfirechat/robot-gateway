package cn.wildfirechat.moltbot;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

/**
 * Moltbot Adapter启动类
 * 负责启动野火IM与Moltbot Gateway的桥接服务
 */
@SpringBootApplication
@ComponentScan(basePackages = "cn.wildfirechat.moltbot")
public class MoltbotAdapterApplication {

    public static void main(String[] args) {
        SpringApplication.run(MoltbotAdapterApplication.class, args);
        System.out.println("========================================");
        System.out.println("  Moltbot Adapter Started Successfully");
        System.out.println("========================================");
    }
}
