#!/bin/bash

# 机器人项目打包脚本

set -e

PROJECT_DIR="/Users/rain/Workspace/robot_server"
cd "$PROJECT_DIR"

echo "========================================="
echo "  机器人项目打包脚本"
echo "========================================="
echo ""

# 清理旧的打包文件
echo ">>> 清理旧的打包文件..."
mvn clean

# 打包所有模块
echo ""
echo ">>> 打包所有模块..."
mvn package -DskipTests

# 检查打包结果
echo ""
echo "========================================="
echo "  打包完成！"
echo "========================================="
echo ""

# 显示打包产物
echo "Gateway:"
if [ -f "gateway/target/gateway-1.0.0.jar" ]; then
    SIZE=$(du -h gateway/target/gateway-1.0.0.jar | cut -f1)
    echo "  ✓ gateway/target/gateway-1.0.0.jar ($SIZE)"
else
    echo "  ✗ Gateway打包失败"
fi

echo ""
echo "Client SDK:"
if [ -f "client/target/client-1.0.0.jar" ]; then
    SIZE=$(du -h client/target/client-1.0.0.jar | cut -f1)
    echo "  ✓ client/target/client-1.0.0.jar ($SIZE)"
    echo "  ✓ client/target/client-1.0.0-sources.jar"
    echo "  ✓ client/target/client-1.0.0-javadoc.jar"
else
    echo "  ✗ Client SDK打包失败"
fi

echo ""
echo "Demo:"
if [ -f "demo/target/demo-1.0.0.jar" ]; then
    SIZE=$(du -h demo/target/demo-1.0.0.jar | cut -f1)
    echo "  ✓ demo/target/demo-1.0.0.jar ($SIZE)"
else
    echo "  ✗ Demo打包失败"
fi

echo ""
echo "========================================="
echo "  快速启动命令"
echo "========================================="
echo ""
echo "启动Gateway:"
echo "  cd gateway/target"
echo "  java -jar gateway-1.0.0.jar"
echo ""
echo "启动Demo:"
echo "  cd demo/target"
echo "  java -jar demo-1.0.0.jar"
echo ""
echo "========================================="
