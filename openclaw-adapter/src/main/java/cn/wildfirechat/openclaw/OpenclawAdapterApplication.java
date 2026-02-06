package cn.wildfirechat.openclaw;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

/**
 * Openclaw Adapter启动类
 * 负责启动野火IM与Openclaw Gateway的桥接服务
 */
@SpringBootApplication
@ComponentScan(basePackages = "cn.wildfirechat.openclaw")
public class OpenclawAdapterApplication {

    public static void main(String[] args) {
        SpringApplication.run(OpenclawAdapterApplication.class, args);
        System.out.println("========================================");
        System.out.println("  Openclaw Adapter Started Successfully");
        System.out.println("========================================");
    }
}
