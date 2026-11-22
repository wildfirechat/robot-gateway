package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGroupMemberWireShape(t *testing.T) {
	raw, err := json.Marshal(PojoGroupMember{MemberID: "u1", Type: 0})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(raw)
	if !strings.Contains(got, `"member_id":"u1"`) {
		t.Fatalf("member_id must be snake_case on the wire, got %s", got)
	}
	if strings.Contains(got, "memberId") {
		t.Fatalf("camelCase memberId leaked to the wire: %s", got)
	}
}

func TestCreateGroupResultDecodesSnakeCase(t *testing.T) {
	var result OutputCreateGroupResult
	if err := json.Unmarshal([]byte(`{"group_id":"group-1"}`), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.GroupID != "group-1" {
		t.Fatalf("group_id not decoded: %+v", result)
	}
}

func TestGroupInfoWireShape(t *testing.T) {
	raw, err := json.Marshal(PojoGroupInfo{Name: "g", MemberCount: 3, JoinType: 2})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(raw)
	for _, want := range []string{`"member_count":3`, `"join_type":2`} {
		if !strings.Contains(got, want) {
			t.Fatalf("want %s in %s", want, got)
		}
	}
}
