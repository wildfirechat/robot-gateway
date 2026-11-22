/** Wildfire group member wire shape used by createGroup/addGroupMembers. */
export interface GroupMember {
    member_id: string;
    type?: 0 | 2;
    alias?: string;
    extra?: string;
}

export interface GroupInfo {
    name: string;
    portrait?: string;
    join_type?: number;
}

export interface CreateGroupResult {
    code: number;
    msg?: string;
    result?: { group_id?: string };
}

export interface GroupApi {
    createGroup(groupInfo: GroupInfo, members: GroupMember[], to: string, lines: number[], payload: any): Promise<CreateGroupResult>;
    addGroupMembers(groupId: string, members: GroupMember[], to: string, lines: number[], payload: any): Promise<any>;
    getGroupInfo(groupId: string): Promise<any>;
    getGroupMembers(groupId: string): Promise<any>;
    dismissGroup(groupId: string, lines: number[], payload: any): Promise<any>;
    transferGroup(groupId: string, newOwner: string, lines: number[], payload: any): Promise<any>;
    modifyGroupInfo(groupId: string, type: number, value: string, lines: number[], payload: any): Promise<any>;
    kickoffGroupMembers(groupId: string, members: string[], lines: number[], payload: any): Promise<any>;
    quitGroup(groupId: string, lines: number[], payload: any): Promise<any>;
    setGroupManager(groupId: string, members: string[], isManager: boolean, lines: number[], payload: any): Promise<any>;
    muteGroupMember(groupId: string, members: string[], mute: boolean, lines: number[], payload: any): Promise<any>;
    allowGroupMember(groupId: string, members: string[], allow: boolean, lines: number[], payload: any): Promise<any>;
    recallMessage(messageUid: string): Promise<any>;
}
