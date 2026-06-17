package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// ── 协议消息 ──────────────────────────────────────────────────────────────

type WSMessage struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	Message   string          `json:"message,omitempty"`
	Hash      string          `json:"hash,omitempty"`
	Bytes     []int           `json:"bytes,omitempty"`
	ImageCount int            `json:"imageCount,omitempty"`
}

type ExportRequest struct {
	RequestID string `json:"requestId,omitempty"`
}

type ExportResult struct {
	Data       json.RawMessage `json:"data"`
	ImageCount int             `json:"imageCount"`
	Error      string          `json:"error,omitempty"`
}

// ── 连接管理 ──────────────────────────────────────────────────────────────

type PluginConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

var (
	plugin   *PluginConn
	pluginMu sync.RWMutex
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func setPlugin(c *websocket.Conn) {
	pluginMu.Lock()
	defer pluginMu.Unlock()
	if plugin != nil {
		plugin.conn.Close()
	}
	plugin = &PluginConn{conn: c}
}

func clearPlugin() {
	pluginMu.Lock()
	defer pluginMu.Unlock()
	plugin = nil
}

func getPlugin() *PluginConn {
	pluginMu.RLock()
	defer pluginMu.RUnlock()
	return plugin
}

func (p *PluginConn) SendJSON(v interface{}) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.conn.WriteJSON(v)
}

// ── 导出请求管理 ──────────────────────────────────────────────────────────

type PendingExport struct {
	Result chan ExportResult
}

var (
	pendingMu sync.Mutex
	pending   = map[string]*PendingExport{}
)

func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ── WebSocket 端点 ────────────────────────────────────────────────────────

var wsHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("❌ WebSocket upgrade error: %v", err)
		return
	}
	log.Printf("✅ Figma plugin connected")
	setPlugin(c)

	defer func() {
		c.Close()
		clearPlugin()
		log.Printf("👋 Figma plugin disconnected")
	}()

	for {
		var msg WSMessage
		if err := c.ReadJSON(&msg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("⚠️ WebSocket read error: %v", err)
			}
			break
		}

		switch msg.Type {
		case "pong":
			// keepalive，无需处理

		case "progress":
			log.Printf("📦 Progress: %s", msg.Message)

		case "done":
			if msg.RequestID != "" {
				pendingMu.Lock()
				pe, ok := pending[msg.RequestID]
				delete(pending, msg.RequestID)
				pendingMu.Unlock()
				if ok {
					pe.Result <- ExportResult{
						Data:       msg.Data,
						ImageCount: msg.ImageCount,
					}
				}
			}

		case "image":
			// 图片数据在 export 返回中一并提供，这里只记录日志
			log.Printf("🖼️ Image received: %s", msg.Hash)

		case "error":
			log.Printf("❌ Plugin error: %s", msg.Message)
			if msg.RequestID != "" {
				pendingMu.Lock()
				pe, ok := pending[msg.RequestID]
				delete(pending, msg.RequestID)
				pendingMu.Unlock()
				if ok {
					pe.Result <- ExportResult{Error: msg.Message}
				}
			}

		case "status":
			// 插件主动上报状态，不做特殊处理
			log.Printf("📡 Plugin status: connected")
		}
	}
})

// ── HTTP API ──────────────────────────────────────────────────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	p := getPlugin()
	connected := p != nil
	json.NewEncoder(w).Encode(map[string]interface{}{
		"connected":   connected,
		"pluginName":  "Figma JSON Exporter",
	})
}

func handleExport(w http.ResponseWriter, r *http.Request) {
	p := getPlugin()
	if p == nil {
		http.Error(w, `{"error":"figma plugin not connected"}`, http.StatusServiceUnavailable)
		return
	}

	reqID := generateID()
	pe := &PendingExport{Result: make(chan ExportResult, 1)}

	pendingMu.Lock()
	pending[reqID] = pe
	pendingMu.Unlock()

	// 发送导出指令给插件
	err := p.SendJSON(WSMessage{
		Type:      "export",
		RequestID: reqID,
	})
	if err != nil {
		pendingMu.Lock()
		delete(pending, reqID)
		pendingMu.Unlock()
		http.Error(w, fmt.Sprintf(`{"error":"send failed: %v"}`, err), http.StatusInternalServerError)
		return
	}

	// 等待结果（最长 120 秒）
	timeout := time.NewTimer(120 * time.Second)
	defer timeout.Stop()

	select {
	case result := <-pe.Result:
		w.Header().Set("Content-Type", "application/json")
		if result.Error != "" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": result.Error})
			return
		}
		w.Write(result.Data)
	case <-timeout.C:
		pendingMu.Lock()
		delete(pending, reqID)
		pendingMu.Unlock()
		http.Error(w, `{"error":"export timed out"}`, http.StatusGatewayTimeout)
	}
}

// ── MCP Server ────────────────────────────────────────────────────────────
// MCP (Model Context Protocol) - 支持 JSON-RPC 协议

type MCPRequest struct {
	JsonRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	ID      json.RawMessage `json:"id,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type MCPResponse struct {
	JsonRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id,omitempty"`
	Result  interface{} `json:"result,omitempty"`
	Error   *MCPError   `json:"error,omitempty"`
}

type MCPError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type MCPTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

type MCPListToolsResult struct {
	Tools []MCPTool `json:"tools"`
}

var mcpHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	var req MCPRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		json.NewEncoder(w).Encode(MCPResponse{
			JsonRPC: "2.0",
			Error:   &MCPError{Code: -32700, Message: "Parse error"},
		})
		return
	}

	switch req.Method {
	case "initialize":
		json.NewEncoder(w).Encode(MCPResponse{
			JsonRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"protocolVersion": "2024-11-05",
				"capabilities": map[string]interface{}{
					"tools": map[string]bool{"listChanged": false},
				},
				"serverInfo": map[string]string{
					"name":    "figma-json-exporter",
					"version": "1.0.0",
				},
			},
		})

	case "tools/list":
		json.NewEncoder(w).Encode(MCPResponse{
			JsonRPC: "2.0",
			ID:      req.ID,
			Result: MCPListToolsResult{
				Tools: []MCPTool{
					{
						Name:        "figma_export",
						Description: "导出 Figma 当前选中节点的完整结构数据（JSON格式），包含样式、约束、Auto Layout 信息",
						InputSchema: json.RawMessage(`{"type":"object","properties":{},"required":[]}`),
					},
					{
						Name:        "figma_status",
						Description: "查看 Figma 插件连接状态",
						InputSchema: json.RawMessage(`{"type":"object","properties":{},"required":[]}`),
					},
				},
			},
		})

	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			json.NewEncoder(w).Encode(MCPResponse{
				JsonRPC: "2.0",
				ID:      req.ID,
				Error:   &MCPError{Code: -32602, Message: "Invalid params"},
			})
			return
		}

		switch params.Name {
		case "figma_export":
			// 复用 HTTP export 逻辑
			p := getPlugin()
			if p == nil {
				json.NewEncoder(w).Encode(MCPResponse{
					JsonRPC: "2.0",
					ID:      req.ID,
					Error:   &MCPError{Code: -32000, Message: "Figma 插件未连接，请先打开 Figma 并启动 JSON Exporter 插件"},
				})
				return
			}

			reqID := generateID()
			pe := &PendingExport{Result: make(chan ExportResult, 1)}

			pendingMu.Lock()
			pending[reqID] = pe
			pendingMu.Unlock()

			err := p.SendJSON(WSMessage{
				Type:      "export",
				RequestID: reqID,
			})
			if err != nil {
				pendingMu.Lock()
				delete(pending, reqID)
				pendingMu.Unlock()
				json.NewEncoder(w).Encode(MCPResponse{
					JsonRPC: "2.0",
					ID:      req.ID,
					Error:   &MCPError{Code: -32000, Message: fmt.Sprintf("发送导出指令失败: %v", err)},
				})
				return
			}

			timeout := time.NewTimer(120 * time.Second)
			defer timeout.Stop()

			select {
			case result := <-pe.Result:
				if result.Error != "" {
					json.NewEncoder(w).Encode(MCPResponse{
						JsonRPC: "2.0",
						ID:      req.ID,
						Error:   &MCPError{Code: -32000, Message: result.Error},
					})
					return
				}
				// 将 JSON 数据作为文本返回
				var prettyData map[string]interface{}
				json.Unmarshal(result.Data, &prettyData)
				json.NewEncoder(w).Encode(MCPResponse{
					JsonRPC: "2.0",
					ID:      req.ID,
					Result: map[string]interface{}{
						"content": []map[string]interface{}{
							{
								"type": "text",
								"text": string(result.Data),
							},
						},
						"isError":  false,
						"meta": map[string]interface{}{
							"imageCount": result.ImageCount,
						},
					},
				})
			case <-timeout.C:
				pendingMu.Lock()
				delete(pending, reqID)
				pendingMu.Unlock()
				json.NewEncoder(w).Encode(MCPResponse{
					JsonRPC: "2.0",
					ID:      req.ID,
					Error:   &MCPError{Code: -32000, Message: "导出超时(120s)"},
				})
			}

		case "figma_status":
			p := getPlugin()
			status := "disconnected"
			if p != nil {
				status = "connected"
			}
			json.NewEncoder(w).Encode(MCPResponse{
				JsonRPC: "2.0",
				ID:      req.ID,
				Result: map[string]interface{}{
					"content": []map[string]interface{}{
						{
							"type": "text",
							"text": fmt.Sprintf("Figma plugin status: %s", status),
						},
					},
					"isError": false,
				},
			})

		default:
			json.NewEncoder(w).Encode(MCPResponse{
				JsonRPC: "2.0",
				ID:      req.ID,
				Error:   &MCPError{Code: -32601, Message: fmt.Sprintf("Unknown tool: %s", params.Name)},
			})
		}

	default:
		json.NewEncoder(w).Encode(MCPResponse{
			JsonRPC: "2.0",
			ID:      req.ID,
			Error:   &MCPError{Code: -32601, Message: fmt.Sprintf("Unknown method: %s", req.Method)},
		})
	}
})

// ── 静态 MCP 端点 ───────────────────────────────────────────────────────
// Comate 直接通过 HTTP URL 配置 MCP，因此不需要 SSE

// ── 主函数 ────────────────────────────────────────────────────────────────

func main() {
	port := "3456"
	if p := os.Getenv("FIGMA_AGENT_PORT"); p != "" {
		port = p
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/status", handleStatus)
	mux.HandleFunc("/export", handleExport)
	mux.Handle("/ws", wsHandler)
	// MCP 支持两种方式：
	// 1. /mcp - 标准 MCP JSON-RPC over HTTP
	// 2. /mcp-sse - SSE 流式 MCP（MCP 2024-11-05 HTTP 模式）
	mux.HandleFunc("/mcp", mcpHandler)

	server := &http.Server{
		Addr:    "localhost:" + port,
		Handler: mux,
	}

	// 优雅退出
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("🚀 Figma Export Agent running on http://localhost:%s", port)
		log.Printf("   WebSocket:   ws://localhost:%s/ws", port)
		log.Printf("   MCP:         http://localhost:%s/mcp", port)
		log.Printf("   Export API:  http://localhost:%s/export", port)
		log.Printf("   Health:      http://localhost:%s/health", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("❌ Server error: %v", err)
		}
	}()

	<-quit
	log.Println("🛑 Shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(ctx)
}
