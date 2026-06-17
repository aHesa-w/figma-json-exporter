#!/bin/bash
# figma-export - CLI 入口
set -e

AGENT_URL="${FIGMA_AGENT_URL:-http://localhost:3456}"

cmd="${1:-help}"

case "$cmd" in
  serve)
    echo "🚀 Starting Figma Export Agent..."
    cd "$(dirname "$0")/agent"
    go run main.go
    ;;
  export)
    echo "📦 Exporting Figma selection..."
    curl -s "$AGENT_URL/export" | python3 -m json.tool 2>/dev/null || curl -s "$AGENT_URL/export"
    ;;
  status)
    echo "📡 Checking Figma plugin status..."
    curl -s "$AGENT_URL/status" | python3 -m json.tool 2>/dev/null || curl -s "$AGENT_URL/status"
    ;;
  health)
    curl -s "$AGENT_URL/health"
    echo ""
    ;;
  *)
    echo "Figma JSON Exporter CLI"
    echo ""
    echo "Usage:"
    echo "  ./figma-export serve    启动 Agent 服务"
    echo "  ./figma-export export   导出当前选中节点 JSON"
    echo "  ./figma-export status   查看插件连接状态"
    echo "  ./figma-export health   健康检查"
    ;;
esac
