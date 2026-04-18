import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

const ddl = `

create table if not exists property_set (
    id integer primary key autoincrement,
    name text not null,
    description text
);

create table if not exists property (
    id integer primary key autoincrement,
    property_set_id integer not null,
    key text not null,
    value text not null,
    foreign key (property_set_id) references property_set(id) on delete cascade
);

create table if not exists session (
    id integer primary key autoincrement,
    parent_session_id integer,
    model_name text not null,
    model_property_set_id integer not null,
    created_at timestamp not null,
    last_active_at timestamp not null,
    status text not null,
    mode text not null default 'agent'
);

create table if not exists session_event (
    id integer primary key,
    session_id integer not null,
    type text not null,
    payload text not null,
    event_at timestamp not null,
    foreign key (session_id) references session(id) on delete cascade
);

create table if not exists conversation (
    id integer primary key,
    session_id integer not null,
    created_at timestamp not null,
    last_active_at timestamp not null,
    status text not null,
    foreign key (session_id) references session(id) on delete cascade
);

create table if not exists message (
    id integer primary key,
    conversation_id integer not null,
    role text not null,
    content text not null,
    message_at timestamp not null,
    foreign key (conversation_id) references conversation(id) on delete cascade
);

create index if not exists idx_session_parent on session(parent_session_id);
create index if not exists idx_session_event_session on session_event(session_id);
create index if not exists idx_conversation_session on conversation(session_id);
create index if not exists idx_message_conversation on message(conversation_id);


`;

export interface Session {
    id: number;
    parentSessionId?: number;
    modelName: string;
    modelPropertySetId: number;
    createdAt: number;
    lastActiveAt: number;
    mode: string;
    status: string;
}


export class Repository {

    private db: Database;

    constructor(workspacePath: string) {
        
        // create the .overlord directory if it doesn't exist
        const overlordDir = path.join(workspacePath, '.overlord');
        if (!fs.existsSync(overlordDir)) {
            fs.mkdirSync(overlordDir);
        }
        const dbPath = path.join(overlordDir, 'repository.db');
        this.db = new Database(dbPath);
        this.initialize();
    }

    private initialize() {
        for (const statement of ddl.split(';').map(s => s.trim()).filter(s => s.length > 0)) {
            this.db.run(statement);
        }

        // Backward-compatible migration for databases created before `session.mode` existed.
        if (!this.hasColumn('session', 'mode')) {
            this.db.run("alter table session add column mode text not null default 'agent'");
        }
    }

    private hasColumn(tableName: string, columnName: string): boolean {
        const rows = this.db.query(`pragma table_info(${tableName})`).all() as Array<{ name?: string }>;
        for (const row of rows) {
            const name = row.name;
            if (name === columnName) {
                return true;
            }
        }
        return false;
    }

    close(): void {
        this.db.close();
    }

    private getPropertySet(propertySetId: number): Record<string, string> {
        const properties: Record<string, string> = {};
        const rows = this.db.query('select key, value from property where property_set_id = ?').all(propertySetId) as Array<{ key: string; value: string }>;
        for (const row of rows) {
            properties[row.key] = row.value;
        }
        return properties;
    }

    private savePropertySet(properties: Record<string, string>): number {
        const result = this.db.run('insert into property_set (name, description) values (?, ?)', ['properties', '']);
        const propertySetId = result.lastInsertRowid as number;
        for (const [key, value] of Object.entries(properties)) {
            this.db.run('insert into property (property_set_id, key, value) values (?, ?, ?)', [propertySetId, key, value]);
        }
        return propertySetId;
    }

    private updatePropertySet(propertySetId: number, properties: Record<string, string>) {
        this.db.run('delete from property where property_set_id = ?', [propertySetId]);
        for (const [key, value] of Object.entries(properties)) {
            this.db.run('insert into property (property_set_id, key, value) values (?, ?, ?)', [propertySetId, key, value]);
        }
    }

    createSession(modelName: string, modelProperties: Record<string, string>, parentSessionId?: number, mode: string = 'agent'): Session {  
        const modelPropertySetId = this.savePropertySet(modelProperties);
        const now = Date.now();
        const result = this.db.run(
            'insert into session (parent_session_id, model_name, model_property_set_id, created_at, last_active_at, status, mode) values (?, ?, ?, ?, ?, ?, ?)',
            [parentSessionId, modelName, modelPropertySetId, now, now, 'active', mode]
        );
        const sessionId = result.lastInsertRowid as number;
        return {
            id: sessionId,
            parentSessionId,
            modelName,
            modelPropertySetId,
            createdAt: now,
            lastActiveAt: now,
            status: 'active',
            mode
        };
    }

    getSession(sessionId: number): Session | null {
        const row = this.db
            .query('select id, parent_session_id, model_name, model_property_set_id, created_at, last_active_at, status, mode from session where id = ?')
            .get(sessionId) as {
                id: number;
                parent_session_id: number | null;
                model_name: string;
                model_property_set_id: number;
                created_at: number;
                last_active_at: number;
                status: string;
                mode: string;
            } | undefined;
        if (!row) {
            return null;
        }
        return {
            id: row.id,
            parentSessionId: row.parent_session_id ?? undefined,
            modelName: row.model_name,
            modelPropertySetId: row.model_property_set_id,
            createdAt: row.created_at,
            lastActiveAt: row.last_active_at,
            status: row.status,
            mode: row.mode,
        };
    }

    getSubSessions(parentSessionId: number): Session[] {
        const rows = this.db
            .query('select id, parent_session_id, model_name, model_property_set_id, created_at, last_active_at, status, mode from session where parent_session_id = ?')
            .all(parentSessionId) as Array<{
                id: number;
                parent_session_id: number | null;
                model_name: string;
                model_property_set_id: number;
                created_at: number;
                last_active_at: number;
                status: string;
                mode: string;
            }>;
        const sessions: Session[] = [];
        for (const row of rows) {
            sessions.push({
                id: row.id,
                parentSessionId: row.parent_session_id ?? undefined,
                modelName: row.model_name,
                modelPropertySetId: row.model_property_set_id,
                createdAt: row.created_at,
                lastActiveAt: row.last_active_at,
                status: row.status,
                mode: row.mode,
            });
        }
        return sessions;
    }

    updateSessionActivity(sessionId: number) {
        const now = Date.now();
        this.db.run('update session set last_active_at = ? where id = ?', [now, sessionId]);
    }

    updateSessionStatus(sessionId: number, status: string) {
        this.db.run('update session set status = ? where id = ?', [status, sessionId]);
    }

    deleteSession(sessionId: number) {
        this.db.run('delete from session where id = ?', [sessionId]);
    }

    /**
     * There can be multiple conversations per session, so we return the most recent active conversation for the session, or create a new one if none exist.
     * @param sessionId 
     * @returns 
     */
    ensureConversation(sessionId: number): number {
        const existing = this.db
            .query('select id from conversation where session_id = ? and status = ? order by last_active_at desc limit 1')
            .get(sessionId, 'active') as { id: number } | undefined;
        if (existing?.id) {
            return existing.id;
        }

        const now = Date.now();
        const result = this.db.run(
            'insert into conversation (session_id, created_at, last_active_at, status) values (?, ?, ?, ?)',
            [sessionId, now, now, 'active']
        );
        return result.lastInsertRowid as number;
    }

    createConversation(sessionId: number, status: string = 'active'): number {
        const now = Date.now();
        const result = this.db.run(
            'insert into conversation (session_id, created_at, last_active_at, status) values (?, ?, ?, ?)',
            [sessionId, now, now, status]
        );
        return result.lastInsertRowid as number;
    }

    updateConversationStatus(conversationId: number, status: string): void {
        const now = Date.now();
        this.db.run(
            'update conversation set status = ?, last_active_at = ? where id = ?',
            [status, now, conversationId]
        );
    }

    private addMessage(conversationId: number, role: string, content: string) {
        const now = Date.now();
        this.db.run('insert into message (conversation_id, role, content, message_at) values (?, ?, ?, ?)', [conversationId, role, content, now]);
    }

    addMessageToConversation(sessionId: number, role: string, content: string) {
        const conversationId = this.ensureConversation(sessionId);
        this.addMessage(conversationId, role, content);
    }

    addMessageToConversationById(conversationId: number, role: string, content: string): void {
        this.addMessage(conversationId, role, content);
    }

    getMessagesForConversation(conversationId: number): { role: string; content: string; messageAt: number }[] {
        const rows = this.db
            .query('select role, content, message_at from message where conversation_id = ? order by message_at asc')
            .all(conversationId) as Array<{ role: string; content: string; message_at: number }>;
        const messages: { role: string; content: string; messageAt: number }[] = [];
        for (const row of rows) {
            messages.push({ role: row.role, content: row.content, messageAt: row.message_at });
        }
        return messages;
    }

}
