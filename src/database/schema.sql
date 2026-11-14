PRAGMA foreign_keys = ON;
-- One fresh schema, intentionally not idempotent: prevents accidental re-initialization.
-- Guild directory and policy; settings are small validated JSON documents.
CREATE TABLE guilds (
 guild_id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL,
 settings_json TEXT NOT NULL DEFAULT '{"notifications":true,"multiple_reviewers":true}' CHECK(json_valid(settings_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE dashboard_role_access (
 guild_id TEXT NOT NULL, role_id TEXT NOT NULL, dashboard INTEGER NOT NULL CHECK(dashboard IN (0,1)),
 permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)), PRIMARY KEY(guild_id,role_id),
 FOREIGN KEY(guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);
CREATE TABLE forms (
 guild_id TEXT NOT NULL, id TEXT NOT NULL, draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
 version INTEGER NOT NULL DEFAULT 0, edit_revision INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed')),
 cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK(cooldown_seconds BETWEEN 0 AND 31536000),
 allow_duplicates INTEGER NOT NULL DEFAULT 0 CHECK(allow_duplicates IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(guild_id,id),
 FOREIGN KEY(guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);
CREATE TABLE form_versions (
 guild_id TEXT NOT NULL, form_id TEXT NOT NULL, version INTEGER NOT NULL,
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)), created_at TEXT NOT NULL,
 PRIMARY KEY(guild_id,form_id,version), FOREIGN KEY(guild_id,form_id) REFERENCES forms(guild_id,id)
);
CREATE TRIGGER immutable_form_version BEFORE UPDATE ON form_versions BEGIN SELECT RAISE(ABORT,'immutable_form_version'); END;
CREATE TABLE applications (
 guild_id TEXT NOT NULL, id TEXT NOT NULL, form_id TEXT NOT NULL, form_version INTEGER NOT NULL,
 applicant_id TEXT NOT NULL, answers_json TEXT NOT NULL CHECK(json_valid(answers_json)),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','under_review','interview','revision_requested','approved','rejected','withdrawn')),
 decision_reason TEXT NOT NULL DEFAULT '', roblox_user_id TEXT, roblox_username TEXT,
 revision INTEGER NOT NULL DEFAULT 0, updated_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(guild_id,id), UNIQUE(id),
 FOREIGN KEY(guild_id,form_id,form_version) REFERENCES form_versions(guild_id,form_id,version)
);
CREATE INDEX applications_queue ON applications(guild_id,status,created_at);
CREATE INDEX applications_owner ON applications(guild_id,applicant_id,created_at);
CREATE INDEX applications_form ON applications(guild_id,form_id,applicant_id,created_at);
-- Atomic submission gate: closure, publish races, duplicate and cooldown checks run inside INSERT.
CREATE TRIGGER submission_guard BEFORE INSERT ON applications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM forms WHERE guild_id=NEW.guild_id AND id=NEW.form_id AND status='open' AND version=NEW.form_version) THEN RAISE(ABORT,'form_closed_or_changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM forms f JOIN applications a ON a.guild_id=f.guild_id AND a.form_id=f.id WHERE f.guild_id=NEW.guild_id AND f.id=NEW.form_id AND a.applicant_id=NEW.applicant_id AND ((f.allow_duplicates=0 AND a.status NOT IN ('approved','rejected','withdrawn')) OR (julianday(NEW.created_at)-julianday(a.created_at))*86400 < f.cooldown_seconds)) THEN RAISE(ABORT,'duplicate_or_cooldown') END;
END;
CREATE TRIGGER status_guard BEFORE UPDATE OF status ON applications WHEN OLD.status<>NEW.status BEGIN
 SELECT CASE WHEN NOT (
 (OLD.status='pending' AND NEW.status IN ('under_review','withdrawn')) OR
 (OLD.status='under_review' AND NEW.status IN ('interview','revision_requested','approved','rejected','withdrawn')) OR
 (OLD.status='interview' AND NEW.status IN ('under_review','revision_requested','approved','rejected','withdrawn')) OR
 (OLD.status='revision_requested' AND NEW.status IN ('pending','withdrawn'))
 ) THEN RAISE(ABORT,'invalid_transition') END;
END;
-- Assignment junction supports multiple reviewers; single-reviewer policy is guarded atomically below.
CREATE TABLE application_reviews (
 guild_id TEXT NOT NULL, application_id TEXT NOT NULL, reviewer_id TEXT NOT NULL, assigned_at TEXT NOT NULL,
 PRIMARY KEY(guild_id,application_id,reviewer_id), FOREIGN KEY(guild_id,application_id) REFERENCES applications(guild_id,id)
);
CREATE TRIGGER single_reviewer_guard BEFORE INSERT ON application_reviews
 WHEN (SELECT json_extract(settings_json,'$.multiple_reviewers') FROM guilds WHERE guild_id=NEW.guild_id)=0 AND EXISTS(SELECT 1 FROM application_reviews WHERE guild_id=NEW.guild_id AND application_id=NEW.application_id AND reviewer_id<>NEW.reviewer_id)
 BEGIN SELECT RAISE(ABORT,'already_assigned'); END;
CREATE TABLE application_notes (
 guild_id TEXT NOT NULL, id TEXT NOT NULL, application_id TEXT NOT NULL, author_id TEXT NOT NULL,
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at TEXT NOT NULL,
 PRIMARY KEY(guild_id,id), FOREIGN KEY(guild_id,application_id) REFERENCES applications(guild_id,id)
);
CREATE TABLE application_events (
 event_id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, application_id TEXT NOT NULL,
 actor_id TEXT NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)), created_at TEXT NOT NULL,
 FOREIGN KEY(guild_id,application_id) REFERENCES applications(guild_id,id)
);
CREATE INDEX events_history ON application_events(guild_id,application_id,event_id);
CREATE TABLE panels (
 guild_id TEXT NOT NULL, id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
 config_json TEXT NOT NULL CHECK(json_valid(config_json)), state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','removing')),
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 PRIMARY KEY(guild_id,id), FOREIGN KEY(guild_id) REFERENCES guilds(guild_id)
);
CREATE TABLE audit_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
 target_id TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(guild_id) REFERENCES guilds(guild_id)
);
CREATE INDEX audit_history ON audit_logs(guild_id,id);
CREATE TRIGGER application_created AFTER INSERT ON applications BEGIN
 INSERT INTO application_events(guild_id,application_id,actor_id,kind,created_at) VALUES(NEW.guild_id,NEW.id,NEW.updated_by,'submitted',NEW.created_at);
 INSERT INTO audit_logs(guild_id,actor_id,action,target_id,created_at) VALUES(NEW.guild_id,NEW.updated_by,'application.submitted',NEW.id,NEW.created_at);
END;
CREATE TRIGGER application_changed AFTER UPDATE ON applications BEGIN
 INSERT INTO application_events(guild_id,application_id,actor_id,kind,data_json,created_at) VALUES(NEW.guild_id,NEW.id,NEW.updated_by,CASE WHEN NEW.status<>OLD.status THEN 'status' WHEN NEW.roblox_user_id IS NOT OLD.roblox_user_id THEN 'roblox_resolved' ELSE 'revision' END,json_object('from',OLD.status,'to',NEW.status,'reason',NEW.decision_reason),NEW.updated_at);
 INSERT INTO audit_logs(guild_id,actor_id,action,target_id,created_at) VALUES(NEW.guild_id,NEW.updated_by,'application.'||NEW.status,NEW.id,NEW.updated_at);
 INSERT INTO notification_jobs(guild_id,application_id,revision,user_id,body,next_attempt) SELECT NEW.guild_id,NEW.id,NEW.revision,NEW.applicant_id,NEW.id||': '||replace(NEW.status,'_',' ')||CASE WHEN NEW.decision_reason<>'' THEN char(10)||NEW.decision_reason ELSE '' END,unixepoch() WHERE NEW.status<>OLD.status AND coalesce((SELECT json_extract(settings_json,'$.notifications') FROM guilds WHERE guild_id=NEW.guild_id),1)=1;
END;
-- Sessions/OAuth/rate-limit/interaction receipts are global infrastructure, not tenant-owned records.
CREATE TABLE dashboard_sessions (
 id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, access_token TEXT NOT NULL,
 csrf_hash TEXT NOT NULL, csrf_token TEXT NOT NULL, selected_guild_id TEXT,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX session_expiry ON dashboard_sessions(expires_at);
CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE interaction_receipts (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL);
CREATE TABLE notification_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, application_id TEXT NOT NULL, revision INTEGER NOT NULL,
 user_id TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
 last_error TEXT, UNIQUE(guild_id,application_id,revision), FOREIGN KEY(guild_id,application_id) REFERENCES applications(guild_id,id)
);
CREATE INDEX notification_due ON notification_jobs(status,next_attempt,lease_until);
