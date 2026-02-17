package client

import (
	"sync"
	"time"

	"github.com/wildfirechat/robot-gateway-sdk/protocol"
)

// ResponseHandler manages pending requests and their responses.
type ResponseHandler struct {
	pendingRequests map[string]chan *protocol.ResponseMessage
	mu              sync.RWMutex
	timeout         time.Duration
}

// NewResponseHandler creates a new ResponseHandler.
func NewResponseHandler() *ResponseHandler {
	return &ResponseHandler{
		pendingRequests: make(map[string]chan *protocol.ResponseMessage),
		timeout:         30 * time.Second,
	}
}

// NewResponseHandlerWithTimeout creates a new ResponseHandler with custom timeout.
func NewResponseHandlerWithTimeout(timeout time.Duration) *ResponseHandler {
	return &ResponseHandler{
		pendingRequests: make(map[string]chan *protocol.ResponseMessage),
		timeout:         timeout,
	}
}

// RegisterRequest registers a new request and returns a channel to receive the response.
func (h *ResponseHandler) RegisterRequest(requestID string) <-chan *protocol.ResponseMessage {
	h.mu.Lock()
	defer h.mu.Unlock()

	ch := make(chan *protocol.ResponseMessage, 1)
	h.pendingRequests[requestID] = ch

	// Set up timeout cleanup
	go func() {
		time.Sleep(h.timeout)
		h.mu.Lock()
		defer h.mu.Unlock()
		if ch, exists := h.pendingRequests[requestID]; exists {
			ch <- &protocol.ResponseMessage{
				RequestID: requestID,
				Code:      -1,
				Msg:       "Request timeout",
			}
			delete(h.pendingRequests, requestID)
		}
	}()

	return ch
}

// HandleResponse handles an incoming response message.
func (h *ResponseHandler) HandleResponse(response *protocol.ResponseMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if ch, exists := h.pendingRequests[response.RequestID]; exists {
		ch <- response
		delete(h.pendingRequests, response.RequestID)
	}
}

// Clear clears all pending requests.
func (h *ResponseHandler) Clear() {
	h.mu.Lock()
	defer h.mu.Unlock()

	for id, ch := range h.pendingRequests {
		ch <- &protocol.ResponseMessage{
			RequestID: id,
			Code:      -1,
			Msg:       "Connection closed",
		}
		delete(h.pendingRequests, id)
	}
}
