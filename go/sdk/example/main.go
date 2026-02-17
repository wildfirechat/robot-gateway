package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/wildfirechat/robot-gateway-sdk/client"
	"github.com/wildfirechat/robot-gateway-sdk/protocol"
)

// SimpleMessageHandler implements the MessageHandler interface.
type SimpleMessageHandler struct{}

func (h *SimpleMessageHandler) OnMessage(message *protocol.PushMessage) {
	if message.Data != nil && message.Data.Payload != nil {
		fmt.Printf("\n[Received] From: %s, Content: %s\n> ",
			message.Data.Sender,
			message.Data.Payload.SearchableContent)
	}
}

func (h *SimpleMessageHandler) OnConnectionChanged(connected bool) {
	if connected {
		fmt.Println("\n[Connected] Connected to gateway")
	} else {
		fmt.Println("\n[Disconnected] Disconnected from gateway")
	}
	fmt.Print("> ")
}

func (h *SimpleMessageHandler) OnError(error string) {
	fmt.Printf("\n[Error] %s\n> ", error)
}

func main() {
	if len(os.Args) < 4 {
		fmt.Println("Usage: example <gateway_url> <robot_id> <robot_secret>")
		fmt.Println("Example: example ws://localhost:8884/robot/gateway MyRobot 123456")
		os.Exit(1)
	}

	gatewayURL := os.Args[1]
	robotID := os.Args[2]
	robotSecret := os.Args[3]

	fmt.Printf("Connecting to %s as %s...\n", gatewayURL, robotID)

	// Create message handler
	handler := &SimpleMessageHandler{}

	// Create client
	robotClient := client.NewRobotServiceClient(gatewayURL, handler)

	// Connect and authenticate
	if !robotClient.Connect(robotID, robotSecret) {
		fmt.Println("Failed to connect or authenticate")
		os.Exit(1)
	}

	fmt.Println("Connected and authenticated!")
	fmt.Println("Commands: send <userId> <text>, info <userId>, profile, help, quit")
	fmt.Print("> ")

	// Interactive command loop
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		parts := strings.Fields(line)

		if len(parts) == 0 {
			fmt.Print("> ")
			continue
		}

		command := parts[0]

		switch command {
		case "send":
			if len(parts) < 3 {
				fmt.Println("Usage: send <userId> <text>")
				break
			}
			targetUserID := parts[1]
			text := strings.Join(parts[2:], " ")

			conv := &protocol.Conversation{
				Type:   0, // Single chat
				Target: targetUserID,
				Line:   0,
			}

			payload := &protocol.MessagePayload{
				Type:              1,
				SearchableContent: text,
			}

			result, err := robotClient.SendMessage(conv, payload)
			if err != nil {
				fmt.Printf("Error: %v\n", err)
			} else if result.IsSuccess() {
				fmt.Printf("Message sent! ID: %d\n", result.Result.MessageUID)
			} else {
				fmt.Printf("Failed: %s (code: %d)\n", result.Msg, result.Code)
			}

		case "info":
			if len(parts) < 2 {
				fmt.Println("Usage: info <userId>")
				break
			}
			userID := parts[1]

			result, err := robotClient.GetUserInfo(userID)
			if err != nil {
				fmt.Printf("Error: %v\n", err)
			} else if result.IsSuccess() {
				fmt.Printf("User: %s\n", result.Result.DisplayName)
				fmt.Printf("  ID: %s\n", result.Result.UserID)
				fmt.Printf("  Portrait: %s\n", result.Result.Portrait)
			} else {
				fmt.Printf("Failed: %s (code: %d)\n", result.Msg, result.Code)
			}

		case "profile":
			result, err := robotClient.GetProfile()
			if err != nil {
				fmt.Printf("Error: %v\n", err)
			} else if result.IsSuccess() {
				fmt.Printf("Robot: %s\n", result.Result.Name)
				fmt.Printf("  ID: %s\n", result.Result.UserID)
				fmt.Printf("  Callback: %s\n", result.Result.Callback)
			} else {
				fmt.Printf("Failed: %s (code: %d)\n", result.Msg, result.Code)
			}

		case "status":
			fmt.Printf("Connected: %v\n", robotClient.IsConnected())
			fmt.Printf("Authenticated: %v\n", robotClient.IsAuthenticated())
			fmt.Printf("Running: %v\n", robotClient.IsRunning())

		case "help":
			fmt.Println("Commands:")
			fmt.Println("  send <userId> <text>  - Send a message")
			fmt.Println("  info <userId>         - Get user info")
			fmt.Println("  profile               - Get robot profile")
			fmt.Println("  status                - Get connection status")
			fmt.Println("  help                  - Show this help")
			fmt.Println("  quit                  - Exit")

		case "quit", "exit":
			fmt.Println("Goodbye!")
			robotClient.Close()
			return

		default:
			fmt.Printf("Unknown command: %s\n", command)
		}

		fmt.Print("> ")
	}

	if err := scanner.Err(); err != nil {
		fmt.Printf("Scanner error: %v\n", err)
	}

	robotClient.Close()
}
