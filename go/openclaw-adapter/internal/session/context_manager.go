package session

import (
	"sync"
	"time"
)

const (
	// DefaultSessionKey is the default session key.
	DefaultSessionKey = "main"
)

// ContextManager manages session contexts.
type ContextManager struct {
	sessions   map[string]*SessionContext
	runIDMap   map[string]string // runId -> sessionKey
	mu         sync.RWMutex
}

// SessionContext stores context for a session.
type SessionContext struct {
	SessionKey string
	SenderID   string
	ThreadID   string
	IsGroup    bool
	Timestamp  int64
}

// NewContextManager creates a new ContextManager.
func NewContextManager() *ContextManager {
	return &ContextManager{
		sessions: make(map[string]*SessionContext),
		runIDMap: make(map[string]string),
	}
}

// RegisterSession registers a session.
func (m *ContextManager) RegisterSession(sessionKey, senderID, threadID string, isGroup bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.sessions[sessionKey] = &SessionContext{
		SessionKey: sessionKey,
		SenderID:   senderID,
		ThreadID:   threadID,
		IsGroup:    isGroup,
		Timestamp:  time.Now().UnixMilli(),
	}
}

// GetSession gets a session by key.
func (m *ContextManager) GetSession(sessionKey string) *SessionContext {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[sessionKey]
}

// AssociateRunID associates a runId with a session key.
func (m *ContextManager) AssociateRunID(runID, sessionKey string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runIDMap[runID] = sessionKey
}

// GetContextByRunID gets session context by runId.
func (m *ContextManager) GetContextByRunID(runID string) *SessionContext {
	m.mu.RLock()
	sessionKey, ok := m.runIDMap[runID]
	m.mu.RUnlock()

	if !ok {
		return nil
	}

	return m.GetSession(sessionKey)
}

// GetDefaultSessionContext gets the default session context.
func (m *ContextManager) GetDefaultSessionContext() *SessionContext {
	return m.GetSession(DefaultSessionKey)
}

// CleanupExpiredSessions removes expired sessions.
func (m *ContextManager) CleanupExpiredSessions(timeoutMs int64) int {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now().UnixMilli()
	removed := 0

	for key, session := range m.sessions {
		if now-session.Timestamp > timeoutMs {
			delete(m.sessions, key)
			removed++
		}
	}

	// Clean up orphaned runId mappings
	for runID, sessionKey := range m.runIDMap {
		if _, exists := m.sessions[sessionKey]; !exists {
			delete(m.runIDMap, runID)
		}
	}

	return removed
}

// GetSessionCount returns the number of active sessions.
func (m *ContextManager) GetSessionCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}

// GetStats returns session statistics.
func (m *ContextManager) GetStats() (total, private, group int) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	total = len(m.sessions)
	for _, session := range m.sessions {
		if session.IsGroup {
			group++
		} else {
			private++
		}
	}

	return total, private, group
}
