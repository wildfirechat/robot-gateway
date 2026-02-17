package client

import "github.com/wildfirechat/robot-gateway-sdk/protocol"

// MessageHandler is the interface for handling incoming messages.
type MessageHandler interface {
	// OnMessage is called when a push message is received.
	OnMessage(message *protocol.PushMessage)
	
	// OnConnectionChanged is called when the connection state changes.
	// connected is true when connected and authenticated, false otherwise.
	OnConnectionChanged(connected bool)
	
	// OnError is called when an error occurs.
	OnError(error string)
}

// DefaultMessageHandler provides a default no-op implementation of MessageHandler.
type DefaultMessageHandler struct{}

// OnMessage implements MessageHandler.
func (h *DefaultMessageHandler) OnMessage(message *protocol.PushMessage) {}

// OnConnectionChanged implements MessageHandler.
func (h *DefaultMessageHandler) OnConnectionChanged(connected bool) {}

// OnError implements MessageHandler.
func (h *DefaultMessageHandler) OnError(error string) {}

// Ensure DefaultMessageHandler implements MessageHandler.
var _ MessageHandler = (*DefaultMessageHandler)(nil)
