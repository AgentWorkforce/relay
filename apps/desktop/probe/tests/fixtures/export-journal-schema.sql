-- The upload schema of an install whose uploads ran on ai-hist's export journal:
-- the probe's delivery tables and the journal's tables, triggers and indexes,
-- as sqlite_master held them. Schema only; no rows.
-- The journal also captured `trajectories`, a table ai-hist has since stopped
-- creating; stub it, as such an install still holds it, so its triggers and
-- index install and the rebuild's cleanup of them stays covered.
CREATE TABLE IF NOT EXISTS trajectories (
    id TEXT PRIMARY KEY, version INTEGER, persona_id TEXT, project_id TEXT,
    task_title TEXT, task_description TEXT, status TEXT, started_at TEXT,
    completed_at TEXT, decisions_json TEXT NOT NULL, retrospective_json TEXT NOT NULL,
    search_text TEXT NOT NULL, path TEXT, updated_ms INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL
);
CREATE TABLE delivery_batches (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','leased','retry_wait','blocked','acknowledged','suppressed','cancelled')),
    payload TEXT, prepared TEXT, records INTEGER NOT NULL, bytes INTEGER NOT NULL,
    journal_end INTEGER NOT NULL, created_ms INTEGER NOT NULL, accepted_records INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE delivery_bootstrap_bounds (
    job_id TEXT NOT NULL, kind TEXT NOT NULL, max_rowid INTEGER NOT NULL,
    PRIMARY KEY(job_id,kind)
);
CREATE TABLE delivery_exclusions (
    source TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(source,session_id)
);
CREATE TABLE delivery_jobs (
    id TEXT PRIMARY KEY, destination_id TEXT NOT NULL, instance_id TEXT NOT NULL, account_id TEXT NOT NULL,
    generation INTEGER NOT NULL, config_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','paused','blocked','cancelled')),
    created_ms INTEGER NOT NULL, cutoff INTEGER NOT NULL, journal_cursor INTEGER NOT NULL,
    bootstrap_kind INTEGER NOT NULL DEFAULT 0, bootstrap_rowid INTEGER NOT NULL DEFAULT 0,
    bootstrap_done INTEGER NOT NULL DEFAULT 0, acknowledged_cursor INTEGER NOT NULL DEFAULT 0,
    fence INTEGER NOT NULL DEFAULT 0, worker_id TEXT, lease_until_ms INTEGER,
    next_attempt_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_ms INTEGER, last_acknowledged_ms INTEGER, acceptance_level TEXT, failure TEXT,
    suppressed_records INTEGER NOT NULL DEFAULT 0, acknowledged_records INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE delivery_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, source TEXT NOT NULL,
    session_id TEXT, record_key TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE delivery_session_jobs (job_id TEXT PRIMARY KEY, last_member TEXT NOT NULL DEFAULT '');
CREATE TABLE delivery_session_members (
 id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL, source TEXT NOT NULL, session_id TEXT NOT NULL,
 cutoff INTEGER NOT NULL, cursor INTEGER NOT NULL, bootstrap_kind INTEGER NOT NULL DEFAULT 0,
 bootstrap_rowid INTEGER NOT NULL DEFAULT 0, bootstrap_done INTEGER NOT NULL DEFAULT 0,
 ready INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(job_id,source,session_id)
);
CREATE TABLE delivery_shadow (
    job_id TEXT NOT NULL, kind TEXT NOT NULL, row_id INTEGER NOT NULL,
    source TEXT NOT NULL, session_id TEXT, record_key TEXT NOT NULL, payload TEXT,
    PRIMARY KEY(job_id,kind,row_id)
);
CREATE TABLE delivery_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), origin_id TEXT NOT NULL,
    retained_bytes INTEGER NOT NULL DEFAULT 0, max_retained_bytes INTEGER NOT NULL DEFAULT 268435456
);
CREATE TABLE history_compaction (singleton INTEGER PRIMARY KEY CHECK(singleton=1), cursor INTEGER NOT NULL);
CREATE TABLE history_export_pages (
 cursor TEXT PRIMARY KEY, export_id TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE history_exports (
 id TEXT PRIMARY KEY, selection_json TEXT NOT NULL, limits_json TEXT NOT NULL,
 cutoff INTEGER NOT NULL, bootstrap_kind INTEGER NOT NULL DEFAULT 0,
 bootstrap_rowid INTEGER NOT NULL DEFAULT 0, bootstrap_done INTEGER NOT NULL DEFAULT 0,
 expires_at_ms INTEGER NOT NULL, cursor TEXT NOT NULL UNIQUE
);
CREATE TABLE history_subscriptions (
 id TEXT PRIMARY KEY, source TEXT, session_id TEXT, journal_cursor INTEGER NOT NULL,
 bootstrap_kind INTEGER NOT NULL DEFAULT 0, bootstrap_rowid INTEGER NOT NULL DEFAULT 0,
 bootstrap_done INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX delivery_active_instance ON delivery_jobs(destination_id,instance_id,account_id) WHERE state <> 'cancelled';
CREATE INDEX delivery_batch_job ON delivery_batches(job_id, seq);
CREATE INDEX delivery_identity_file_edits ON file_edits(source,session_id);
CREATE INDEX delivery_identity_history ON history(source,session_id);
CREATE INDEX delivery_identity_observation_evidence ON observation_evidence(source,session_id);
CREATE INDEX delivery_identity_session_commit_links ON session_commit_links(source,session_id);
CREATE INDEX delivery_identity_session_events ON session_events(source,session_id);
CREATE INDEX delivery_identity_session_markers ON session_markers(source,session_id);
CREATE INDEX delivery_identity_session_observations ON session_observations(source,session_id);
CREATE INDEX delivery_identity_session_presences ON session_presences(source,session_id);
CREATE INDEX delivery_identity_session_relationships ON session_relationships(source,parent_session_id);
CREATE INDEX delivery_identity_sessions ON sessions(source,session_id);
CREATE INDEX delivery_identity_tool_calls ON tool_calls(source,session_id);
CREATE INDEX delivery_identity_trajectories ON trajectories(id);
CREATE INDEX delivery_journal_session ON delivery_journal(source,session_id,seq);
CREATE INDEX delivery_member_cursor ON delivery_session_members(job_id,cursor);
CREATE INDEX delivery_member_identity ON delivery_session_members(source,session_id);
CREATE INDEX delivery_member_ready ON delivery_session_members(job_id,ready,id);
CREATE INDEX delivery_member_snapshot ON delivery_session_members(job_id,bootstrap_done);
CREATE UNIQUE INDEX delivery_one_pending_batch ON delivery_batches(job_id) WHERE state IN ('pending','leased','retry_wait','blocked');
CREATE INDEX delivery_shadow_session ON delivery_shadow(job_id,kind,source,session_id,row_id);
CREATE INDEX history_export_page_owner ON history_export_pages(export_id);
CREATE INDEX history_subscription_cursor ON history_subscriptions(journal_cursor);
CREATE INDEX history_subscription_identity ON history_subscriptions(source,session_id,journal_cursor);
CREATE TRIGGER delivery_batches_cap_insert BEFORE INSERT ON delivery_batches BEGIN
 SELECT CASE WHEN (SELECT retained_bytes+(coalesce(length(CAST(NEW.payload AS BLOB)),0)+coalesce(length(CAST(NEW.prepared AS BLOB)),0)+512)>max_retained_bytes FROM delivery_state WHERE singleton=1) THEN RAISE(ABORT,'delivery retention limit exceeded; compact consumed data or raise the retention cap') END;
END;
CREATE TRIGGER delivery_batches_cap_update BEFORE UPDATE ON delivery_batches BEGIN
 SELECT CASE WHEN (SELECT retained_bytes+(coalesce(length(CAST(NEW.payload AS BLOB)),0)+coalesce(length(CAST(NEW.prepared AS BLOB)),0)+512)-(coalesce(length(CAST(OLD.payload AS BLOB)),0)+coalesce(length(CAST(OLD.prepared AS BLOB)),0)+512)>max_retained_bytes FROM delivery_state WHERE singleton=1) THEN RAISE(ABORT,'delivery retention limit exceeded; compact consumed data or raise the retention cap') END;
END;
CREATE TRIGGER delivery_batches_count_delete AFTER DELETE ON delivery_batches BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes-(coalesce(length(CAST(OLD.payload AS BLOB)),0)+coalesce(length(CAST(OLD.prepared AS BLOB)),0)+512) WHERE singleton=1;
END;
CREATE TRIGGER delivery_batches_count_insert AFTER INSERT ON delivery_batches BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes+(coalesce(length(CAST(NEW.payload AS BLOB)),0)+coalesce(length(CAST(NEW.prepared AS BLOB)),0)+512) WHERE singleton=1;
END;
CREATE TRIGGER delivery_batches_count_update AFTER UPDATE ON delivery_batches BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes+(coalesce(length(CAST(NEW.payload AS BLOB)),0)+coalesce(length(CAST(NEW.prepared AS BLOB)),0)+512)-(coalesce(length(CAST(OLD.payload AS BLOB)),0)+coalesce(length(CAST(OLD.prepared AS BLOB)),0)+512) WHERE singleton=1;
END;
CREATE TRIGGER delivery_file_edits_delete AFTER DELETE ON file_edits
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'file_edit',OLD.rowid,OLD.source,OLD.session_id,json_array('file_edit',OLD.source,OLD.session_id,OLD.tool_use_id),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'message_id',OLD."message_id",'tool_use_id',OLD."tool_use_id",'file_path',OLD."file_path",'tool_name',OLD."tool_name",'lines_added',OLD."lines_added",'lines_removed',OLD."lines_removed",'structured_patch_json',OLD."structured_patch_json",'user_modified',OLD."user_modified",'ts_ms',OLD."ts_ms",'git_branch',OLD."git_branch",'cwd',OLD."cwd")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='file_edit'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) )
 AND (j.bootstrap_kind < 3 OR (j.bootstrap_kind=3 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='file_edit' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'file_edit',OLD.source,OLD.session_id,json_array('file_edit',OLD.source,OLD.session_id,OLD.tool_use_id),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
END;
CREATE TRIGGER delivery_file_edits_insert AFTER INSERT ON file_edits
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'file_edit',NEW.rowid,NEW.source,NEW.session_id,json_array('file_edit',NEW.source,NEW.session_id,NEW.tool_use_id),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='file_edit'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id) )
 AND (j.bootstrap_kind < 3 OR (j.bootstrap_kind=3 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='file_edit' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'file_edit',NEW.source,NEW.session_id,json_array('file_edit',NEW.source,NEW.session_id,NEW.tool_use_id),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'message_id',NEW."message_id",'tool_use_id',NEW."tool_use_id",'file_path',NEW."file_path",'tool_name',NEW."tool_name",'lines_added',NEW."lines_added",'lines_removed',NEW."lines_removed",'structured_patch_json',NEW."structured_patch_json",'user_modified',NEW."user_modified",'ts_ms',NEW."ts_ms",'git_branch',NEW."git_branch",'cwd',NEW."cwd") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_file_edits_update AFTER UPDATE ON file_edits
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'message_id',OLD."message_id",'tool_use_id',OLD."tool_use_id",'file_path',OLD."file_path",'tool_name',OLD."tool_name",'lines_added',OLD."lines_added",'lines_removed',OLD."lines_removed",'structured_patch_json',OLD."structured_patch_json",'user_modified',OLD."user_modified",'ts_ms',OLD."ts_ms",'git_branch',OLD."git_branch",'cwd',OLD."cwd") <> json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'message_id',NEW."message_id",'tool_use_id',NEW."tool_use_id",'file_path',NEW."file_path",'tool_name',NEW."tool_name",'lines_added',NEW."lines_added",'lines_removed',NEW."lines_removed",'structured_patch_json',NEW."structured_patch_json",'user_modified',NEW."user_modified",'ts_ms',NEW."ts_ms",'git_branch',NEW."git_branch",'cwd',NEW."cwd") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'file_edit',OLD.rowid,OLD.source,OLD.session_id,json_array('file_edit',OLD.source,OLD.session_id,OLD.tool_use_id),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'message_id',OLD."message_id",'tool_use_id',OLD."tool_use_id",'file_path',OLD."file_path",'tool_name',OLD."tool_name",'lines_added',OLD."lines_added",'lines_removed',OLD."lines_removed",'structured_patch_json',OLD."structured_patch_json",'user_modified',OLD."user_modified",'ts_ms',OLD."ts_ms",'git_branch',OLD."git_branch",'cwd',OLD."cwd")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='file_edit'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 3 OR (j.bootstrap_kind=3 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='file_edit' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'file_edit',NEW.rowid,NEW.source,NEW.session_id,json_array('file_edit',NEW.source,NEW.session_id,NEW.tool_use_id),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='file_edit'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 3 OR (j.bootstrap_kind=3 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='file_edit' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'file_edit',OLD.source,OLD.session_id,json_array('file_edit',OLD.source,OLD.session_id,OLD.tool_use_id),'delete','null' WHERE json_array('file_edit',OLD.source,OLD.session_id,OLD.tool_use_id) <> json_array('file_edit',NEW.source,NEW.session_id,NEW.tool_use_id) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'file_edit',NEW.source,NEW.session_id,json_array('file_edit',NEW.source,NEW.session_id,NEW.tool_use_id),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'message_id',NEW."message_id",'tool_use_id',NEW."tool_use_id",'file_path',NEW."file_path",'tool_name',NEW."tool_name",'lines_added',NEW."lines_added",'lines_removed',NEW."lines_removed",'structured_patch_json',NEW."structured_patch_json",'user_modified',NEW."user_modified",'ts_ms',NEW."ts_ms",'git_branch',NEW."git_branch",'cwd',NEW."cwd") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_history_delete AFTER DELETE ON history
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'history',OLD.rowid,OLD.source,OLD.session_id,json_array('history',OLD.source,OLD.timestamp_ms,OLD.prompt),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'project',OLD."project",'prompt',OLD."prompt",'prompt_hash',OLD."prompt_hash",'timestamp_ms',OLD."timestamp_ms",'git_branch',OLD."git_branch")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='history'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) )
 AND (j.bootstrap_kind < 0 OR (j.bootstrap_kind=0 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='history' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'history',OLD.source,OLD.session_id,json_array('history',OLD.source,OLD.timestamp_ms,OLD.prompt),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
END;
CREATE TRIGGER delivery_history_insert AFTER INSERT ON history
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'history',NEW.rowid,NEW.source,NEW.session_id,json_array('history',NEW.source,NEW.timestamp_ms,NEW.prompt),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='history'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id) )
 AND (j.bootstrap_kind < 0 OR (j.bootstrap_kind=0 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='history' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'history',NEW.source,NEW.session_id,json_array('history',NEW.source,NEW.timestamp_ms,NEW.prompt),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'project',NEW."project",'prompt',NEW."prompt",'prompt_hash',NEW."prompt_hash",'timestamp_ms',NEW."timestamp_ms",'git_branch',NEW."git_branch") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_history_update AFTER UPDATE ON history
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'project',OLD."project",'prompt',OLD."prompt",'prompt_hash',OLD."prompt_hash",'timestamp_ms',OLD."timestamp_ms",'git_branch',OLD."git_branch") <> json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'project',NEW."project",'prompt',NEW."prompt",'prompt_hash',NEW."prompt_hash",'timestamp_ms',NEW."timestamp_ms",'git_branch',NEW."git_branch") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'history',OLD.rowid,OLD.source,OLD.session_id,json_array('history',OLD.source,OLD.timestamp_ms,OLD.prompt),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'project',OLD."project",'prompt',OLD."prompt",'prompt_hash',OLD."prompt_hash",'timestamp_ms',OLD."timestamp_ms",'git_branch',OLD."git_branch")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='history'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 0 OR (j.bootstrap_kind=0 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='history' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'history',NEW.rowid,NEW.source,NEW.session_id,json_array('history',NEW.source,NEW.timestamp_ms,NEW.prompt),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='history'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 0 OR (j.bootstrap_kind=0 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='history' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'history',OLD.source,OLD.session_id,json_array('history',OLD.source,OLD.timestamp_ms,OLD.prompt),'delete','null' WHERE json_array('history',OLD.source,OLD.timestamp_ms,OLD.prompt) <> json_array('history',NEW.source,NEW.timestamp_ms,NEW.prompt) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'history',NEW.source,NEW.session_id,json_array('history',NEW.source,NEW.timestamp_ms,NEW.prompt),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'project',NEW."project",'prompt',NEW."prompt",'prompt_hash',NEW."prompt_hash",'timestamp_ms',NEW."timestamp_ms",'git_branch',NEW."git_branch") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_journal_cap_insert BEFORE INSERT ON delivery_journal BEGIN
 SELECT CASE WHEN (SELECT retained_bytes+(length(CAST(NEW.payload AS BLOB))+length(CAST(NEW.record_key AS BLOB))+512)>max_retained_bytes FROM delivery_state WHERE singleton=1) THEN RAISE(ABORT,'delivery retention limit exceeded; compact consumed data or raise the retention cap') END;
END;
CREATE TRIGGER delivery_journal_cap_update BEFORE UPDATE ON delivery_journal BEGIN
 SELECT CASE WHEN (SELECT retained_bytes+(length(CAST(NEW.payload AS BLOB))+length(CAST(NEW.record_key AS BLOB))+512)-(length(CAST(OLD.payload AS BLOB))+length(CAST(OLD.record_key AS BLOB))+512)>max_retained_bytes FROM delivery_state WHERE singleton=1) THEN RAISE(ABORT,'delivery retention limit exceeded; compact consumed data or raise the retention cap') END;
END;
CREATE TRIGGER delivery_journal_count_delete AFTER DELETE ON delivery_journal BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes-(length(CAST(OLD.payload AS BLOB))+length(CAST(OLD.record_key AS BLOB))+512) WHERE singleton=1;
END;
CREATE TRIGGER delivery_journal_count_insert AFTER INSERT ON delivery_journal BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes+(length(CAST(NEW.payload AS BLOB))+length(CAST(NEW.record_key AS BLOB))+512) WHERE singleton=1;
END;
CREATE TRIGGER delivery_journal_count_update AFTER UPDATE ON delivery_journal BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes+(length(CAST(NEW.payload AS BLOB))+length(CAST(NEW.record_key AS BLOB))+512)-(length(CAST(OLD.payload AS BLOB))+length(CAST(OLD.record_key AS BLOB))+512) WHERE singleton=1;
END;
CREATE TRIGGER delivery_observation_evidence_delete AFTER DELETE ON observation_evidence
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'observation_evidence',OLD.rowid,OLD.source,OLD.session_id,json_array('observation_evidence',OLD.source,OLD.session_id,OLD.location,OLD.connector_id,OLD.connector_instance,OLD.evidence_uid),json_object('source',OLD."source",'session_id',OLD."session_id",'location',OLD."location",'connector_id',OLD."connector_id",'connector_instance',OLD."connector_instance",'evidence_uid',OLD."evidence_uid",'payload_json',OLD."payload_json")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='observation_evidence'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) )
 AND (j.bootstrap_kind < 10 OR (j.bootstrap_kind=10 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='observation_evidence' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'observation_evidence',OLD.source,OLD.session_id,json_array('observation_evidence',OLD.source,OLD.session_id,OLD.location,OLD.connector_id,OLD.connector_instance,OLD.evidence_uid),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
END;
CREATE TRIGGER delivery_observation_evidence_insert AFTER INSERT ON observation_evidence
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'observation_evidence',NEW.rowid,NEW.source,NEW.session_id,json_array('observation_evidence',NEW.source,NEW.session_id,NEW.location,NEW.connector_id,NEW.connector_instance,NEW.evidence_uid),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='observation_evidence'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id) )
 AND (j.bootstrap_kind < 10 OR (j.bootstrap_kind=10 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='observation_evidence' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'observation_evidence',NEW.source,NEW.session_id,json_array('observation_evidence',NEW.source,NEW.session_id,NEW.location,NEW.connector_id,NEW.connector_instance,NEW.evidence_uid),'upsert',json_object('source',NEW."source",'session_id',NEW."session_id",'location',NEW."location",'connector_id',NEW."connector_id",'connector_instance',NEW."connector_instance",'evidence_uid',NEW."evidence_uid",'payload_json',NEW."payload_json") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_observation_evidence_update AFTER UPDATE ON observation_evidence
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('source',OLD."source",'session_id',OLD."session_id",'location',OLD."location",'connector_id',OLD."connector_id",'connector_instance',OLD."connector_instance",'evidence_uid',OLD."evidence_uid",'payload_json',OLD."payload_json") <> json_object('source',NEW."source",'session_id',NEW."session_id",'location',NEW."location",'connector_id',NEW."connector_id",'connector_instance',NEW."connector_instance",'evidence_uid',NEW."evidence_uid",'payload_json',NEW."payload_json") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'observation_evidence',OLD.rowid,OLD.source,OLD.session_id,json_array('observation_evidence',OLD.source,OLD.session_id,OLD.location,OLD.connector_id,OLD.connector_instance,OLD.evidence_uid),json_object('source',OLD."source",'session_id',OLD."session_id",'location',OLD."location",'connector_id',OLD."connector_id",'connector_instance',OLD."connector_instance",'evidence_uid',OLD."evidence_uid",'payload_json',OLD."payload_json")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='observation_evidence'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 10 OR (j.bootstrap_kind=10 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='observation_evidence' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'observation_evidence',NEW.rowid,NEW.source,NEW.session_id,json_array('observation_evidence',NEW.source,NEW.session_id,NEW.location,NEW.connector_id,NEW.connector_instance,NEW.evidence_uid),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='observation_evidence'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 10 OR (j.bootstrap_kind=10 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='observation_evidence' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'observation_evidence',OLD.source,OLD.session_id,json_array('observation_evidence',OLD.source,OLD.session_id,OLD.location,OLD.connector_id,OLD.connector_instance,OLD.evidence_uid),'delete','null' WHERE json_array('observation_evidence',OLD.source,OLD.session_id,OLD.location,OLD.connector_id,OLD.connector_instance,OLD.evidence_uid) <> json_array('observation_evidence',NEW.source,NEW.session_id,NEW.location,NEW.connector_id,NEW.connector_instance,NEW.evidence_uid) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'observation_evidence',NEW.source,NEW.session_id,json_array('observation_evidence',NEW.source,NEW.session_id,NEW.location,NEW.connector_id,NEW.connector_instance,NEW.evidence_uid),'upsert',json_object('source',NEW."source",'session_id',NEW."session_id",'location',NEW."location",'connector_id',NEW."connector_id",'connector_instance',NEW."connector_instance",'evidence_uid',NEW."evidence_uid",'payload_json',NEW."payload_json") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_commit_links_delete AFTER DELETE ON session_commit_links
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'commit_link',OLD.rowid,OLD.source,OLD.session_id,json_array('commit_link',OLD.source,OLD.session_id,OLD.commit_sha,OLD.match_method),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'repo',OLD."repo",'branch',OLD."branch",'commit_sha',OLD."commit_sha",'note_ref',OLD."note_ref",'match_method',OLD."match_method",'confidence',OLD."confidence",'files_json',OLD."files_json",'numstat_json',OLD."numstat_json",'evidence_json',OLD."evidence_json",'created_at_ms',OLD."created_at_ms")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='commit_link'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) )
 AND (j.bootstrap_kind < 7 OR (j.bootstrap_kind=7 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='commit_link' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'commit_link',OLD.source,OLD.session_id,json_array('commit_link',OLD.source,OLD.session_id,OLD.commit_sha,OLD.match_method),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
END;
CREATE TRIGGER delivery_session_commit_links_insert AFTER INSERT ON session_commit_links
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'commit_link',NEW.rowid,NEW.source,NEW.session_id,json_array('commit_link',NEW.source,NEW.session_id,NEW.commit_sha,NEW.match_method),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='commit_link'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id) )
 AND (j.bootstrap_kind < 7 OR (j.bootstrap_kind=7 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='commit_link' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'commit_link',NEW.source,NEW.session_id,json_array('commit_link',NEW.source,NEW.session_id,NEW.commit_sha,NEW.match_method),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'repo',NEW."repo",'branch',NEW."branch",'commit_sha',NEW."commit_sha",'note_ref',NEW."note_ref",'match_method',NEW."match_method",'confidence',NEW."confidence",'files_json',NEW."files_json",'numstat_json',NEW."numstat_json",'evidence_json',NEW."evidence_json",'created_at_ms',NEW."created_at_ms") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_commit_links_update AFTER UPDATE ON session_commit_links
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'repo',OLD."repo",'branch',OLD."branch",'commit_sha',OLD."commit_sha",'note_ref',OLD."note_ref",'match_method',OLD."match_method",'confidence',OLD."confidence",'files_json',OLD."files_json",'numstat_json',OLD."numstat_json",'evidence_json',OLD."evidence_json",'created_at_ms',OLD."created_at_ms") <> json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'repo',NEW."repo",'branch',NEW."branch",'commit_sha',NEW."commit_sha",'note_ref',NEW."note_ref",'match_method',NEW."match_method",'confidence',NEW."confidence",'files_json',NEW."files_json",'numstat_json',NEW."numstat_json",'evidence_json',NEW."evidence_json",'created_at_ms',NEW."created_at_ms") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'commit_link',OLD.rowid,OLD.source,OLD.session_id,json_array('commit_link',OLD.source,OLD.session_id,OLD.commit_sha,OLD.match_method),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'repo',OLD."repo",'branch',OLD."branch",'commit_sha',OLD."commit_sha",'note_ref',OLD."note_ref",'match_method',OLD."match_method",'confidence',OLD."confidence",'files_json',OLD."files_json",'numstat_json',OLD."numstat_json",'evidence_json',OLD."evidence_json",'created_at_ms',OLD."created_at_ms")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='commit_link'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 7 OR (j.bootstrap_kind=7 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='commit_link' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'commit_link',NEW.rowid,NEW.source,NEW.session_id,json_array('commit_link',NEW.source,NEW.session_id,NEW.commit_sha,NEW.match_method),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='commit_link'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 7 OR (j.bootstrap_kind=7 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='commit_link' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'commit_link',OLD.source,OLD.session_id,json_array('commit_link',OLD.source,OLD.session_id,OLD.commit_sha,OLD.match_method),'delete','null' WHERE json_array('commit_link',OLD.source,OLD.session_id,OLD.commit_sha,OLD.match_method) <> json_array('commit_link',NEW.source,NEW.session_id,NEW.commit_sha,NEW.match_method) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'commit_link',NEW.source,NEW.session_id,json_array('commit_link',NEW.source,NEW.session_id,NEW.commit_sha,NEW.match_method),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'repo',NEW."repo",'branch',NEW."branch",'commit_sha',NEW."commit_sha",'note_ref',NEW."note_ref",'match_method',NEW."match_method",'confidence',NEW."confidence",'files_json',NEW."files_json",'numstat_json',NEW."numstat_json",'evidence_json',NEW."evidence_json",'created_at_ms',NEW."created_at_ms") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_events_delete AFTER DELETE ON session_events
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session_event',OLD.rowid,OLD.source,OLD.session_id,json_array('session_event',OLD.source,OLD.session_id,OLD.event_uid),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'project',OLD."project",'project_key',OLD."project_key",'project_key_method',OLD."project_key_method",'cwd',OLD."cwd",'git_branch',OLD."git_branch",'message_id',OLD."message_id",'parent_id',OLD."parent_id",'ts_ms',OLD."ts_ms",'role',OLD."role",'kind',OLD."kind",'text',OLD."text",'model',OLD."model",'token_json',OLD."token_json",'provider',OLD."provider",'event_uid',OLD."event_uid",'tool_use_id',OLD."tool_use_id",'payload_bytes',OLD."payload_bytes",'payload_truncated',OLD."payload_truncated",'payload_hash',OLD."payload_hash",'call_index',OLD."call_index",'event_index',OLD."event_index",'result_status',OLD."result_status",'event_source',OLD."event_source",'error_signal',OLD."error_signal",'subagent_session_id',OLD."subagent_session_id",'agent_id',OLD."agent_id",'request_id',OLD."request_id",'provider_message_id',OLD."provider_message_id",'stop_reason',OLD."stop_reason",'agent_version',OLD."agent_version",'is_sidechain',OLD."is_sidechain",'is_meta',OLD."is_meta",'turn_id',OLD."turn_id",'request_span',OLD."request_span",'raw_facts_version',OLD."raw_facts_version",'raw_kind',OLD."raw_kind",'control_kind',OLD."control_kind")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session_event'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) )
 AND (j.bootstrap_kind < 1 OR (j.bootstrap_kind=1 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session_event' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session_event',OLD.source,OLD.session_id,json_array('session_event',OLD.source,OLD.session_id,OLD.event_uid),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
END;
CREATE TRIGGER delivery_session_events_insert AFTER INSERT ON session_events
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session_event',NEW.rowid,NEW.source,NEW.session_id,json_array('session_event',NEW.source,NEW.session_id,NEW.event_uid),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session_event'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id) )
 AND (j.bootstrap_kind < 1 OR (j.bootstrap_kind=1 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session_event' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session_event',NEW.source,NEW.session_id,json_array('session_event',NEW.source,NEW.session_id,NEW.event_uid),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'project',NEW."project",'project_key',NEW."project_key",'project_key_method',NEW."project_key_method",'cwd',NEW."cwd",'git_branch',NEW."git_branch",'message_id',NEW."message_id",'parent_id',NEW."parent_id",'ts_ms',NEW."ts_ms",'role',NEW."role",'kind',NEW."kind",'text',NEW."text",'model',NEW."model",'token_json',NEW."token_json",'provider',NEW."provider",'event_uid',NEW."event_uid",'tool_use_id',NEW."tool_use_id",'payload_bytes',NEW."payload_bytes",'payload_truncated',NEW."payload_truncated",'payload_hash',NEW."payload_hash",'call_index',NEW."call_index",'event_index',NEW."event_index",'result_status',NEW."result_status",'event_source',NEW."event_source",'error_signal',NEW."error_signal",'subagent_session_id',NEW."subagent_session_id",'agent_id',NEW."agent_id",'request_id',NEW."request_id",'provider_message_id',NEW."provider_message_id",'stop_reason',NEW."stop_reason",'agent_version',NEW."agent_version",'is_sidechain',NEW."is_sidechain",'is_meta',NEW."is_meta",'turn_id',NEW."turn_id",'request_span',NEW."request_span",'raw_facts_version',NEW."raw_facts_version",'raw_kind',NEW."raw_kind",'control_kind',NEW."control_kind") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_events_update AFTER UPDATE ON session_events
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'project',OLD."project",'project_key',OLD."project_key",'project_key_method',OLD."project_key_method",'cwd',OLD."cwd",'git_branch',OLD."git_branch",'message_id',OLD."message_id",'parent_id',OLD."parent_id",'ts_ms',OLD."ts_ms",'role',OLD."role",'kind',OLD."kind",'text',OLD."text",'model',OLD."model",'token_json',OLD."token_json",'provider',OLD."provider",'event_uid',OLD."event_uid",'tool_use_id',OLD."tool_use_id",'payload_bytes',OLD."payload_bytes",'payload_truncated',OLD."payload_truncated",'payload_hash',OLD."payload_hash",'call_index',OLD."call_index",'event_index',OLD."event_index",'result_status',OLD."result_status",'event_source',OLD."event_source",'error_signal',OLD."error_signal",'subagent_session_id',OLD."subagent_session_id",'agent_id',OLD."agent_id",'request_id',OLD."request_id",'provider_message_id',OLD."provider_message_id",'stop_reason',OLD."stop_reason",'agent_version',OLD."agent_version",'is_sidechain',OLD."is_sidechain",'is_meta',OLD."is_meta",'turn_id',OLD."turn_id",'request_span',OLD."request_span",'raw_facts_version',OLD."raw_facts_version",'raw_kind',OLD."raw_kind",'control_kind',OLD."control_kind") <> json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'project',NEW."project",'project_key',NEW."project_key",'project_key_method',NEW."project_key_method",'cwd',NEW."cwd",'git_branch',NEW."git_branch",'message_id',NEW."message_id",'parent_id',NEW."parent_id",'ts_ms',NEW."ts_ms",'role',NEW."role",'kind',NEW."kind",'text',NEW."text",'model',NEW."model",'token_json',NEW."token_json",'provider',NEW."provider",'event_uid',NEW."event_uid",'tool_use_id',NEW."tool_use_id",'payload_bytes',NEW."payload_bytes",'payload_truncated',NEW."payload_truncated",'payload_hash',NEW."payload_hash",'call_index',NEW."call_index",'event_index',NEW."event_index",'result_status',NEW."result_status",'event_source',NEW."event_source",'error_signal',NEW."error_signal",'subagent_session_id',NEW."subagent_session_id",'agent_id',NEW."agent_id",'request_id',NEW."request_id",'provider_message_id',NEW."provider_message_id",'stop_reason',NEW."stop_reason",'agent_version',NEW."agent_version",'is_sidechain',NEW."is_sidechain",'is_meta',NEW."is_meta",'turn_id',NEW."turn_id",'request_span',NEW."request_span",'raw_facts_version',NEW."raw_facts_version",'raw_kind',NEW."raw_kind",'control_kind',NEW."control_kind") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session_event',OLD.rowid,OLD.source,OLD.session_id,json_array('session_event',OLD.source,OLD.session_id,OLD.event_uid),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'project',OLD."project",'project_key',OLD."project_key",'project_key_method',OLD."project_key_method",'cwd',OLD."cwd",'git_branch',OLD."git_branch",'message_id',OLD."message_id",'parent_id',OLD."parent_id",'ts_ms',OLD."ts_ms",'role',OLD."role",'kind',OLD."kind",'text',OLD."text",'model',OLD."model",'token_json',OLD."token_json",'provider',OLD."provider",'event_uid',OLD."event_uid",'tool_use_id',OLD."tool_use_id",'payload_bytes',OLD."payload_bytes",'payload_truncated',OLD."payload_truncated",'payload_hash',OLD."payload_hash",'call_index',OLD."call_index",'event_index',OLD."event_index",'result_status',OLD."result_status",'event_source',OLD."event_source",'error_signal',OLD."error_signal",'subagent_session_id',OLD."subagent_session_id",'agent_id',OLD."agent_id",'request_id',OLD."request_id",'provider_message_id',OLD."provider_message_id",'stop_reason',OLD."stop_reason",'agent_version',OLD."agent_version",'is_sidechain',OLD."is_sidechain",'is_meta',OLD."is_meta",'turn_id',OLD."turn_id",'request_span',OLD."request_span",'raw_facts_version',OLD."raw_facts_version",'raw_kind',OLD."raw_kind",'control_kind',OLD."control_kind")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session_event'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 1 OR (j.bootstrap_kind=1 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session_event' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session_event',NEW.rowid,NEW.source,NEW.session_id,json_array('session_event',NEW.source,NEW.session_id,NEW.event_uid),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session_event'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 1 OR (j.bootstrap_kind=1 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session_event' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session_event',OLD.source,OLD.session_id,json_array('session_event',OLD.source,OLD.session_id,OLD.event_uid),'delete','null' WHERE json_array('session_event',OLD.source,OLD.session_id,OLD.event_uid) <> json_array('session_event',NEW.source,NEW.session_id,NEW.event_uid) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session_event',NEW.source,NEW.session_id,json_array('session_event',NEW.source,NEW.session_id,NEW.event_uid),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'project',NEW."project",'project_key',NEW."project_key",'project_key_method',NEW."project_key_method",'cwd',NEW."cwd",'git_branch',NEW."git_branch",'message_id',NEW."message_id",'parent_id',NEW."parent_id",'ts_ms',NEW."ts_ms",'role',NEW."role",'kind',NEW."kind",'text',NEW."text",'model',NEW."model",'token_json',NEW."token_json",'provider',NEW."provider",'event_uid',NEW."event_uid",'tool_use_id',NEW."tool_use_id",'payload_bytes',NEW."payload_bytes",'payload_truncated',NEW."payload_truncated",'payload_hash',NEW."payload_hash",'call_index',NEW."call_index",'event_index',NEW."event_index",'result_status',NEW."result_status",'event_source',NEW."event_source",'error_signal',NEW."error_signal",'subagent_session_id',NEW."subagent_session_id",'agent_id',NEW."agent_id",'request_id',NEW."request_id",'provider_message_id',NEW."provider_message_id",'stop_reason',NEW."stop_reason",'agent_version',NEW."agent_version",'is_sidechain',NEW."is_sidechain",'is_meta',NEW."is_meta",'turn_id',NEW."turn_id",'request_span',NEW."request_span",'raw_facts_version',NEW."raw_facts_version",'raw_kind',NEW."raw_kind",'control_kind',NEW."control_kind") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_markers_delete AFTER DELETE ON session_markers
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session_marker',OLD.rowid,OLD.source,OLD.session_id,json_array('session_marker',OLD.source,OLD.session_id,OLD.marker_uid),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'marker_uid',OLD."marker_uid",'ts_ms',OLD."ts_ms",'message_id',OLD."message_id",'parent_id',OLD."parent_id",'turn_id',OLD."turn_id",'kind',OLD."kind",'subkind',OLD."subkind",'text',OLD."text",'payload_json',OLD."payload_json")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session_marker'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) )
 AND (j.bootstrap_kind < 11 OR (j.bootstrap_kind=11 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session_marker' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session_marker',OLD.source,OLD.session_id,json_array('session_marker',OLD.source,OLD.session_id,OLD.marker_uid),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
END;
CREATE TRIGGER delivery_session_markers_insert AFTER INSERT ON session_markers
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session_marker',NEW.rowid,NEW.source,NEW.session_id,json_array('session_marker',NEW.source,NEW.session_id,NEW.marker_uid),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session_marker'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id) )
 AND (j.bootstrap_kind < 11 OR (j.bootstrap_kind=11 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session_marker' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session_marker',NEW.source,NEW.session_id,json_array('session_marker',NEW.source,NEW.session_id,NEW.marker_uid),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'marker_uid',NEW."marker_uid",'ts_ms',NEW."ts_ms",'message_id',NEW."message_id",'parent_id',NEW."parent_id",'turn_id',NEW."turn_id",'kind',NEW."kind",'subkind',NEW."subkind",'text',NEW."text",'payload_json',NEW."payload_json") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_markers_update AFTER UPDATE ON session_markers
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'marker_uid',OLD."marker_uid",'ts_ms',OLD."ts_ms",'message_id',OLD."message_id",'parent_id',OLD."parent_id",'turn_id',OLD."turn_id",'kind',OLD."kind",'subkind',OLD."subkind",'text',OLD."text",'payload_json',OLD."payload_json") <> json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'marker_uid',NEW."marker_uid",'ts_ms',NEW."ts_ms",'message_id',NEW."message_id",'parent_id',NEW."parent_id",'turn_id',NEW."turn_id",'kind',NEW."kind",'subkind',NEW."subkind",'text',NEW."text",'payload_json',NEW."payload_json") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session_marker',OLD.rowid,OLD.source,OLD.session_id,json_array('session_marker',OLD.source,OLD.session_id,OLD.marker_uid),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'marker_uid',OLD."marker_uid",'ts_ms',OLD."ts_ms",'message_id',OLD."message_id",'parent_id',OLD."parent_id",'turn_id',OLD."turn_id",'kind',OLD."kind",'subkind',OLD."subkind",'text',OLD."text",'payload_json',OLD."payload_json")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session_marker'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 11 OR (j.bootstrap_kind=11 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session_marker' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session_marker',NEW.rowid,NEW.source,NEW.session_id,json_array('session_marker',NEW.source,NEW.session_id,NEW.marker_uid),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session_marker'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 11 OR (j.bootstrap_kind=11 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session_marker' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session_marker',OLD.source,OLD.session_id,json_array('session_marker',OLD.source,OLD.session_id,OLD.marker_uid),'delete','null' WHERE json_array('session_marker',OLD.source,OLD.session_id,OLD.marker_uid) <> json_array('session_marker',NEW.source,NEW.session_id,NEW.marker_uid) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session_marker',NEW.source,NEW.session_id,json_array('session_marker',NEW.source,NEW.session_id,NEW.marker_uid),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'marker_uid',NEW."marker_uid",'ts_ms',NEW."ts_ms",'message_id',NEW."message_id",'parent_id',NEW."parent_id",'turn_id',NEW."turn_id",'kind',NEW."kind",'subkind',NEW."subkind",'text',NEW."text",'payload_json',NEW."payload_json") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_observations_delete AFTER DELETE ON session_observations
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'source_observation',OLD.rowid,OLD.source,OLD.session_id,json_array('source_observation',OLD.source,OLD.session_id,OLD.location,OLD.connector_id,OLD.connector_instance),json_object('source',OLD."source",'session_id',OLD."session_id",'location',OLD."location",'connector_id',OLD."connector_id",'connector_instance',OLD."connector_instance",'raw_locator',OLD."raw_locator",'source_stamp',OLD."source_stamp",'discovery_state',OLD."discovery_state",'access_state',OLD."access_state",'updated_ms',OLD."updated_ms")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='source_observation'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) )
 AND (j.bootstrap_kind < 9 OR (j.bootstrap_kind=9 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='source_observation' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'source_observation',OLD.source,OLD.session_id,json_array('source_observation',OLD.source,OLD.session_id,OLD.location,OLD.connector_id,OLD.connector_instance),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
END;
CREATE TRIGGER delivery_session_observations_insert AFTER INSERT ON session_observations
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'source_observation',NEW.rowid,NEW.source,NEW.session_id,json_array('source_observation',NEW.source,NEW.session_id,NEW.location,NEW.connector_id,NEW.connector_instance),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='source_observation'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id) )
 AND (j.bootstrap_kind < 9 OR (j.bootstrap_kind=9 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='source_observation' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'source_observation',NEW.source,NEW.session_id,json_array('source_observation',NEW.source,NEW.session_id,NEW.location,NEW.connector_id,NEW.connector_instance),'upsert',json_object('source',NEW."source",'session_id',NEW."session_id",'location',NEW."location",'connector_id',NEW."connector_id",'connector_instance',NEW."connector_instance",'raw_locator',NEW."raw_locator",'source_stamp',NEW."source_stamp",'discovery_state',NEW."discovery_state",'access_state',NEW."access_state",'updated_ms',NEW."updated_ms") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_observations_update AFTER UPDATE ON session_observations
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('source',OLD."source",'session_id',OLD."session_id",'location',OLD."location",'connector_id',OLD."connector_id",'connector_instance',OLD."connector_instance",'raw_locator',OLD."raw_locator",'source_stamp',OLD."source_stamp",'discovery_state',OLD."discovery_state",'access_state',OLD."access_state",'updated_ms',OLD."updated_ms") <> json_object('source',NEW."source",'session_id',NEW."session_id",'location',NEW."location",'connector_id',NEW."connector_id",'connector_instance',NEW."connector_instance",'raw_locator',NEW."raw_locator",'source_stamp',NEW."source_stamp",'discovery_state',NEW."discovery_state",'access_state',NEW."access_state",'updated_ms',NEW."updated_ms") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'source_observation',OLD.rowid,OLD.source,OLD.session_id,json_array('source_observation',OLD.source,OLD.session_id,OLD.location,OLD.connector_id,OLD.connector_instance),json_object('source',OLD."source",'session_id',OLD."session_id",'location',OLD."location",'connector_id',OLD."connector_id",'connector_instance',OLD."connector_instance",'raw_locator',OLD."raw_locator",'source_stamp',OLD."source_stamp",'discovery_state',OLD."discovery_state",'access_state',OLD."access_state",'updated_ms',OLD."updated_ms")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='source_observation'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 9 OR (j.bootstrap_kind=9 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='source_observation' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'source_observation',NEW.rowid,NEW.source,NEW.session_id,json_array('source_observation',NEW.source,NEW.session_id,NEW.location,NEW.connector_id,NEW.connector_instance),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='source_observation'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 9 OR (j.bootstrap_kind=9 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='source_observation' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'source_observation',OLD.source,OLD.session_id,json_array('source_observation',OLD.source,OLD.session_id,OLD.location,OLD.connector_id,OLD.connector_instance),'delete','null' WHERE json_array('source_observation',OLD.source,OLD.session_id,OLD.location,OLD.connector_id,OLD.connector_instance) <> json_array('source_observation',NEW.source,NEW.session_id,NEW.location,NEW.connector_id,NEW.connector_instance) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'source_observation',NEW.source,NEW.session_id,json_array('source_observation',NEW.source,NEW.session_id,NEW.location,NEW.connector_id,NEW.connector_instance),'upsert',json_object('source',NEW."source",'session_id',NEW."session_id",'location',NEW."location",'connector_id',NEW."connector_id",'connector_instance',NEW."connector_instance",'raw_locator',NEW."raw_locator",'source_stamp',NEW."source_stamp",'discovery_state',NEW."discovery_state",'access_state',NEW."access_state",'updated_ms',NEW."updated_ms") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_presences_delete AFTER DELETE ON session_presences
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'presence',OLD.rowid,OLD.source,OLD.session_id,json_array('presence',OLD.source,OLD.session_id,OLD.location),json_object('source',OLD."source",'session_id',OLD."session_id",'location',OLD."location",'raw_locator',OLD."raw_locator",'source_stamp',OLD."source_stamp",'discovery_state',OLD."discovery_state")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='presence'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) )
 AND (j.bootstrap_kind < 5 OR (j.bootstrap_kind=5 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='presence' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'presence',OLD.source,OLD.session_id,json_array('presence',OLD.source,OLD.session_id,OLD.location),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
END;
CREATE TRIGGER delivery_session_presences_insert AFTER INSERT ON session_presences
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'presence',NEW.rowid,NEW.source,NEW.session_id,json_array('presence',NEW.source,NEW.session_id,NEW.location),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='presence'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id) )
 AND (j.bootstrap_kind < 5 OR (j.bootstrap_kind=5 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='presence' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'presence',NEW.source,NEW.session_id,json_array('presence',NEW.source,NEW.session_id,NEW.location),'upsert',json_object('source',NEW."source",'session_id',NEW."session_id",'location',NEW."location",'raw_locator',NEW."raw_locator",'source_stamp',NEW."source_stamp",'discovery_state',NEW."discovery_state") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_presences_update AFTER UPDATE ON session_presences
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('source',OLD."source",'session_id',OLD."session_id",'location',OLD."location",'raw_locator',OLD."raw_locator",'source_stamp',OLD."source_stamp",'discovery_state',OLD."discovery_state") <> json_object('source',NEW."source",'session_id',NEW."session_id",'location',NEW."location",'raw_locator',NEW."raw_locator",'source_stamp',NEW."source_stamp",'discovery_state',NEW."discovery_state") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'presence',OLD.rowid,OLD.source,OLD.session_id,json_array('presence',OLD.source,OLD.session_id,OLD.location),json_object('source',OLD."source",'session_id',OLD."session_id",'location',OLD."location",'raw_locator',OLD."raw_locator",'source_stamp',OLD."source_stamp",'discovery_state',OLD."discovery_state")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='presence'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 5 OR (j.bootstrap_kind=5 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='presence' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'presence',NEW.rowid,NEW.source,NEW.session_id,json_array('presence',NEW.source,NEW.session_id,NEW.location),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='presence'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 5 OR (j.bootstrap_kind=5 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='presence' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'presence',OLD.source,OLD.session_id,json_array('presence',OLD.source,OLD.session_id,OLD.location),'delete','null' WHERE json_array('presence',OLD.source,OLD.session_id,OLD.location) <> json_array('presence',NEW.source,NEW.session_id,NEW.location) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'presence',NEW.source,NEW.session_id,json_array('presence',NEW.source,NEW.session_id,NEW.location),'upsert',json_object('source',NEW."source",'session_id',NEW."session_id",'location',NEW."location",'raw_locator',NEW."raw_locator",'source_stamp',NEW."source_stamp",'discovery_state',NEW."discovery_state") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_session_ready AFTER INSERT ON delivery_journal BEGIN
 UPDATE delivery_session_members SET ready=1 WHERE source=NEW.source AND session_id=NEW.session_id AND ready=0;
END;
CREATE TRIGGER delivery_session_relationships_delete AFTER DELETE ON session_relationships
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'relationship',OLD.rowid,OLD.source,OLD.parent_session_id,json_array('relationship',OLD.source,OLD.parent_session_id,OLD.relationship_uid),json_object('source',OLD."source",'parent_session_id',OLD."parent_session_id",'relationship_uid',OLD."relationship_uid",'child_session_id',OLD."child_session_id",'relationship',OLD."relationship",'identity_status',OLD."identity_status",'child_agent_type',OLD."child_agent_type",'child_agent_name',OLD."child_agent_name",'child_model',OLD."child_model",'spawn_depth',OLD."spawn_depth",'evidence_kind',OLD."evidence_kind",'evidence_locator',OLD."evidence_locator",'evidence_ref',OLD."evidence_ref",'child_has_events',OLD."child_has_events",'spawned_at_ms',OLD."spawned_at_ms",'created_ms',OLD."created_ms",'updated_ms',OLD."updated_ms",'origin_session_id',OLD."origin_session_id")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='relationship'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.parent_session_id) )
 AND (j.bootstrap_kind < 6 OR (j.bootstrap_kind=6 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='relationship' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'relationship',OLD.source,OLD.parent_session_id,json_array('relationship',OLD.source,OLD.parent_session_id,OLD.relationship_uid),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.parent_session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.parent_session_id));
END;
CREATE TRIGGER delivery_session_relationships_insert AFTER INSERT ON session_relationships
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'relationship',NEW.rowid,NEW.source,NEW.parent_session_id,json_array('relationship',NEW.source,NEW.parent_session_id,NEW.relationship_uid),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='relationship'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.parent_session_id) )
 AND (j.bootstrap_kind < 6 OR (j.bootstrap_kind=6 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='relationship' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'relationship',NEW.source,NEW.parent_session_id,json_array('relationship',NEW.source,NEW.parent_session_id,NEW.relationship_uid),'upsert',json_object('source',NEW."source",'parent_session_id',NEW."parent_session_id",'relationship_uid',NEW."relationship_uid",'child_session_id',NEW."child_session_id",'relationship',NEW."relationship",'identity_status',NEW."identity_status",'child_agent_type',NEW."child_agent_type",'child_agent_name',NEW."child_agent_name",'child_model',NEW."child_model",'spawn_depth',NEW."spawn_depth",'evidence_kind',NEW."evidence_kind",'evidence_locator',NEW."evidence_locator",'evidence_ref',NEW."evidence_ref",'child_has_events',NEW."child_has_events",'spawned_at_ms',NEW."spawned_at_ms",'created_ms',NEW."created_ms",'updated_ms',NEW."updated_ms",'origin_session_id',NEW."origin_session_id") WHERE (((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.parent_session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.parent_session_id)) AND (NEW.child_session_id IS NULL OR ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.child_session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.child_session_id))));
END;
CREATE TRIGGER delivery_session_relationships_update AFTER UPDATE ON session_relationships
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('source',OLD."source",'parent_session_id',OLD."parent_session_id",'relationship_uid',OLD."relationship_uid",'child_session_id',OLD."child_session_id",'relationship',OLD."relationship",'identity_status',OLD."identity_status",'child_agent_type',OLD."child_agent_type",'child_agent_name',OLD."child_agent_name",'child_model',OLD."child_model",'spawn_depth',OLD."spawn_depth",'evidence_kind',OLD."evidence_kind",'evidence_locator',OLD."evidence_locator",'evidence_ref',OLD."evidence_ref",'child_has_events',OLD."child_has_events",'spawned_at_ms',OLD."spawned_at_ms",'created_ms',OLD."created_ms",'updated_ms',OLD."updated_ms",'origin_session_id',OLD."origin_session_id") <> json_object('source',NEW."source",'parent_session_id',NEW."parent_session_id",'relationship_uid',NEW."relationship_uid",'child_session_id',NEW."child_session_id",'relationship',NEW."relationship",'identity_status',NEW."identity_status",'child_agent_type',NEW."child_agent_type",'child_agent_name',NEW."child_agent_name",'child_model',NEW."child_model",'spawn_depth',NEW."spawn_depth",'evidence_kind',NEW."evidence_kind",'evidence_locator',NEW."evidence_locator",'evidence_ref',NEW."evidence_ref",'child_has_events',NEW."child_has_events",'spawned_at_ms',NEW."spawned_at_ms",'created_ms',NEW."created_ms",'updated_ms',NEW."updated_ms",'origin_session_id',NEW."origin_session_id") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'relationship',OLD.rowid,OLD.source,OLD.parent_session_id,json_array('relationship',OLD.source,OLD.parent_session_id,OLD.relationship_uid),json_object('source',OLD."source",'parent_session_id',OLD."parent_session_id",'relationship_uid',OLD."relationship_uid",'child_session_id',OLD."child_session_id",'relationship',OLD."relationship",'identity_status',OLD."identity_status",'child_agent_type',OLD."child_agent_type",'child_agent_name',OLD."child_agent_name",'child_model',OLD."child_model",'spawn_depth',OLD."spawn_depth",'evidence_kind',OLD."evidence_kind",'evidence_locator',OLD."evidence_locator",'evidence_ref',OLD."evidence_ref",'child_has_events',OLD."child_has_events",'spawned_at_ms',OLD."spawned_at_ms",'created_ms',OLD."created_ms",'updated_ms',OLD."updated_ms",'origin_session_id',OLD."origin_session_id")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='relationship'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.parent_session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.parent_session_id))
 AND (j.bootstrap_kind < 6 OR (j.bootstrap_kind=6 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='relationship' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'relationship',NEW.rowid,NEW.source,NEW.parent_session_id,json_array('relationship',NEW.source,NEW.parent_session_id,NEW.relationship_uid),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='relationship'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.parent_session_id))
 AND (j.bootstrap_kind < 6 OR (j.bootstrap_kind=6 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='relationship' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'relationship',OLD.source,OLD.parent_session_id,json_array('relationship',OLD.source,OLD.parent_session_id,OLD.relationship_uid),'delete','null' WHERE json_array('relationship',OLD.source,OLD.parent_session_id,OLD.relationship_uid) <> json_array('relationship',NEW.source,NEW.parent_session_id,NEW.relationship_uid) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.parent_session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.parent_session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'relationship',NEW.source,NEW.parent_session_id,json_array('relationship',NEW.source,NEW.parent_session_id,NEW.relationship_uid),'upsert',json_object('source',NEW."source",'parent_session_id',NEW."parent_session_id",'relationship_uid',NEW."relationship_uid",'child_session_id',NEW."child_session_id",'relationship',NEW."relationship",'identity_status',NEW."identity_status",'child_agent_type',NEW."child_agent_type",'child_agent_name',NEW."child_agent_name",'child_model',NEW."child_model",'spawn_depth',NEW."spawn_depth",'evidence_kind',NEW."evidence_kind",'evidence_locator',NEW."evidence_locator",'evidence_ref',NEW."evidence_ref",'child_has_events',NEW."child_has_events",'spawned_at_ms',NEW."spawned_at_ms",'created_ms',NEW."created_ms",'updated_ms',NEW."updated_ms",'origin_session_id',NEW."origin_session_id") WHERE (((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.parent_session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.parent_session_id)) AND (NEW.child_session_id IS NULL OR ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.child_session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.child_session_id))));
END;
CREATE TRIGGER delivery_sessions_delete AFTER DELETE ON sessions
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session',OLD.rowid,OLD.source,OLD.session_id,json_array('session',OLD.source,OLD.session_id),json_object('session_id',OLD."session_id",'source',OLD."source",'cwd',OLD."cwd",'git_branch',OLD."git_branch",'first_activity_ms',OLD."first_activity_ms",'last_activity_ms',OLD."last_activity_ms",'last_assistant_text',OLD."last_assistant_text",'raw_path',OLD."raw_path",'parser_version',OLD."parser_version",'first_prompt',OLD."first_prompt",'models_json',OLD."models_json",'originator',OLD."originator",'agent_version',OLD."agent_version",'repo_url',OLD."repo_url",'initial_commit',OLD."initial_commit",'workspace_roots_json',OLD."workspace_roots_json",'source_stamp',OLD."source_stamp",'discovery_state',OLD."discovery_state",'project_key',OLD."project_key",'project_key_method',OLD."project_key_method")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) )
 AND (j.bootstrap_kind < 4 OR (j.bootstrap_kind=4 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session',OLD.source,OLD.session_id,json_array('session',OLD.source,OLD.session_id),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
END;
CREATE TRIGGER delivery_sessions_insert AFTER INSERT ON sessions
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session',NEW.rowid,NEW.source,NEW.session_id,json_array('session',NEW.source,NEW.session_id),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id) )
 AND (j.bootstrap_kind < 4 OR (j.bootstrap_kind=4 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session',NEW.source,NEW.session_id,json_array('session',NEW.source,NEW.session_id),'upsert',json_object('session_id',NEW."session_id",'source',NEW."source",'cwd',NEW."cwd",'git_branch',NEW."git_branch",'first_activity_ms',NEW."first_activity_ms",'last_activity_ms',NEW."last_activity_ms",'last_assistant_text',NEW."last_assistant_text",'raw_path',NEW."raw_path",'parser_version',NEW."parser_version",'first_prompt',NEW."first_prompt",'models_json',NEW."models_json",'originator',NEW."originator",'agent_version',NEW."agent_version",'repo_url',NEW."repo_url",'initial_commit',NEW."initial_commit",'workspace_roots_json',NEW."workspace_roots_json",'source_stamp',NEW."source_stamp",'discovery_state',NEW."discovery_state",'project_key',NEW."project_key",'project_key_method',NEW."project_key_method") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_sessions_update AFTER UPDATE ON sessions
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('session_id',OLD."session_id",'source',OLD."source",'cwd',OLD."cwd",'git_branch',OLD."git_branch",'first_activity_ms',OLD."first_activity_ms",'last_activity_ms',OLD."last_activity_ms",'last_assistant_text',OLD."last_assistant_text",'raw_path',OLD."raw_path",'parser_version',OLD."parser_version",'first_prompt',OLD."first_prompt",'models_json',OLD."models_json",'originator',OLD."originator",'agent_version',OLD."agent_version",'repo_url',OLD."repo_url",'initial_commit',OLD."initial_commit",'workspace_roots_json',OLD."workspace_roots_json",'source_stamp',OLD."source_stamp",'discovery_state',OLD."discovery_state",'project_key',OLD."project_key",'project_key_method',OLD."project_key_method") <> json_object('session_id',NEW."session_id",'source',NEW."source",'cwd',NEW."cwd",'git_branch',NEW."git_branch",'first_activity_ms',NEW."first_activity_ms",'last_activity_ms',NEW."last_activity_ms",'last_assistant_text',NEW."last_assistant_text",'raw_path',NEW."raw_path",'parser_version',NEW."parser_version",'first_prompt',NEW."first_prompt",'models_json',NEW."models_json",'originator',NEW."originator",'agent_version',NEW."agent_version",'repo_url',NEW."repo_url",'initial_commit',NEW."initial_commit",'workspace_roots_json',NEW."workspace_roots_json",'source_stamp',NEW."source_stamp",'discovery_state',NEW."discovery_state",'project_key',NEW."project_key",'project_key_method',NEW."project_key_method") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session',OLD.rowid,OLD.source,OLD.session_id,json_array('session',OLD.source,OLD.session_id),json_object('session_id',OLD."session_id",'source',OLD."source",'cwd',OLD."cwd",'git_branch',OLD."git_branch",'first_activity_ms',OLD."first_activity_ms",'last_activity_ms',OLD."last_activity_ms",'last_assistant_text',OLD."last_assistant_text",'raw_path',OLD."raw_path",'parser_version',OLD."parser_version",'first_prompt',OLD."first_prompt",'models_json',OLD."models_json",'originator',OLD."originator",'agent_version',OLD."agent_version",'repo_url',OLD."repo_url",'initial_commit',OLD."initial_commit",'workspace_roots_json',OLD."workspace_roots_json",'source_stamp',OLD."source_stamp",'discovery_state',OLD."discovery_state",'project_key',OLD."project_key",'project_key_method',OLD."project_key_method")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 4 OR (j.bootstrap_kind=4 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'session',NEW.rowid,NEW.source,NEW.session_id,json_array('session',NEW.source,NEW.session_id),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='session'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 4 OR (j.bootstrap_kind=4 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='session' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session',OLD.source,OLD.session_id,json_array('session',OLD.source,OLD.session_id),'delete','null' WHERE json_array('session',OLD.source,OLD.session_id) <> json_array('session',NEW.source,NEW.session_id) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'session',NEW.source,NEW.session_id,json_array('session',NEW.source,NEW.session_id),'upsert',json_object('session_id',NEW."session_id",'source',NEW."source",'cwd',NEW."cwd",'git_branch',NEW."git_branch",'first_activity_ms',NEW."first_activity_ms",'last_activity_ms',NEW."last_activity_ms",'last_assistant_text',NEW."last_assistant_text",'raw_path',NEW."raw_path",'parser_version',NEW."parser_version",'first_prompt',NEW."first_prompt",'models_json',NEW."models_json",'originator',NEW."originator",'agent_version',NEW."agent_version",'repo_url',NEW."repo_url",'initial_commit',NEW."initial_commit",'workspace_roots_json',NEW."workspace_roots_json",'source_stamp',NEW."source_stamp",'discovery_state',NEW."discovery_state",'project_key',NEW."project_key",'project_key_method',NEW."project_key_method") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_shadow_cap_insert BEFORE INSERT ON delivery_shadow BEGIN
 SELECT CASE WHEN (SELECT retained_bytes+(coalesce(length(CAST(NEW.payload AS BLOB)),0)+length(CAST(NEW.record_key AS BLOB))+512)>max_retained_bytes FROM delivery_state WHERE singleton=1) THEN RAISE(ABORT,'delivery retention limit exceeded; compact consumed data or raise the retention cap') END;
END;
CREATE TRIGGER delivery_shadow_cap_update BEFORE UPDATE ON delivery_shadow BEGIN
 SELECT CASE WHEN (SELECT retained_bytes+(coalesce(length(CAST(NEW.payload AS BLOB)),0)+length(CAST(NEW.record_key AS BLOB))+512)-(coalesce(length(CAST(OLD.payload AS BLOB)),0)+length(CAST(OLD.record_key AS BLOB))+512)>max_retained_bytes FROM delivery_state WHERE singleton=1) THEN RAISE(ABORT,'delivery retention limit exceeded; compact consumed data or raise the retention cap') END;
END;
CREATE TRIGGER delivery_shadow_count_delete AFTER DELETE ON delivery_shadow BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes-(coalesce(length(CAST(OLD.payload AS BLOB)),0)+length(CAST(OLD.record_key AS BLOB))+512) WHERE singleton=1;
END;
CREATE TRIGGER delivery_shadow_count_insert AFTER INSERT ON delivery_shadow BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes+(coalesce(length(CAST(NEW.payload AS BLOB)),0)+length(CAST(NEW.record_key AS BLOB))+512) WHERE singleton=1;
END;
CREATE TRIGGER delivery_shadow_count_update AFTER UPDATE ON delivery_shadow BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes+(coalesce(length(CAST(NEW.payload AS BLOB)),0)+length(CAST(NEW.record_key AS BLOB))+512)-(coalesce(length(CAST(OLD.payload AS BLOB)),0)+length(CAST(OLD.record_key AS BLOB))+512) WHERE singleton=1;
END;
CREATE TRIGGER delivery_tool_calls_delete AFTER DELETE ON tool_calls
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'tool_call',OLD.rowid,OLD.source,OLD.session_id,json_array('tool_call',OLD.source,OLD.session_id,OLD.tool_use_id),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'message_id',OLD."message_id",'tool_use_id',OLD."tool_use_id",'name',OLD."name",'target',OLD."target",'args_json',OLD."args_json",'is_error',OLD."is_error",'ts_ms',OLD."ts_ms")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='tool_call'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) )
 AND (j.bootstrap_kind < 2 OR (j.bootstrap_kind=2 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='tool_call' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'tool_call',OLD.source,OLD.session_id,json_array('tool_call',OLD.source,OLD.session_id,OLD.tool_use_id),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
END;
CREATE TRIGGER delivery_tool_calls_insert AFTER INSERT ON tool_calls
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'tool_call',NEW.rowid,NEW.source,NEW.session_id,json_array('tool_call',NEW.source,NEW.session_id,NEW.tool_use_id),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='tool_call'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id) )
 AND (j.bootstrap_kind < 2 OR (j.bootstrap_kind=2 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='tool_call' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'tool_call',NEW.source,NEW.session_id,json_array('tool_call',NEW.source,NEW.session_id,NEW.tool_use_id),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'message_id',NEW."message_id",'tool_use_id',NEW."tool_use_id",'name',NEW."name",'target',NEW."target",'args_json',NEW."args_json",'is_error',NEW."is_error",'ts_ms',NEW."ts_ms") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_tool_calls_update AFTER UPDATE ON tool_calls
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'message_id',OLD."message_id",'tool_use_id',OLD."tool_use_id",'name',OLD."name",'target',OLD."target",'args_json',OLD."args_json",'is_error',OLD."is_error",'ts_ms',OLD."ts_ms") <> json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'message_id',NEW."message_id",'tool_use_id',NEW."tool_use_id",'name',NEW."name",'target',NEW."target",'args_json',NEW."args_json",'is_error',NEW."is_error",'ts_ms',NEW."ts_ms") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'tool_call',OLD.rowid,OLD.source,OLD.session_id,json_array('tool_call',OLD.source,OLD.session_id,OLD.tool_use_id),json_object('id',OLD."id",'source',OLD."source",'session_id',OLD."session_id",'message_id',OLD."message_id",'tool_use_id',OLD."tool_use_id",'name',OLD."name",'target',OLD."target",'args_json',OLD."args_json",'is_error',OLD."is_error",'ts_ms',OLD."ts_ms")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='tool_call'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=OLD.source AND j.member_session=OLD.session_id) OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 2 OR (j.bootstrap_kind=2 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='tool_call' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'tool_call',NEW.rowid,NEW.source,NEW.session_id,json_array('tool_call',NEW.source,NEW.session_id,NEW.tool_use_id),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='tool_call'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source=NEW.source AND j.member_session=NEW.session_id))
 AND (j.bootstrap_kind < 2 OR (j.bootstrap_kind=2 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='tool_call' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'tool_call',OLD.source,OLD.session_id,json_array('tool_call',OLD.source,OLD.session_id,OLD.tool_use_id),'delete','null' WHERE json_array('tool_call',OLD.source,OLD.session_id,OLD.tool_use_id) <> json_array('tool_call',NEW.source,NEW.session_id,NEW.tool_use_id) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=OLD.source AND session_id=OLD.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=OLD.source AND session_id=OLD.session_id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'tool_call',NEW.source,NEW.session_id,json_array('tool_call',NEW.source,NEW.session_id,NEW.tool_use_id),'upsert',json_object('id',NEW."id",'source',NEW."source",'session_id',NEW."session_id",'message_id',NEW."message_id",'tool_use_id',NEW."tool_use_id",'name',NEW."name",'target',NEW."target",'args_json',NEW."args_json",'is_error',NEW."is_error",'ts_ms',NEW."ts_ms") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source=NEW.source AND session_id=NEW.session_id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=NEW.source AND session_id=NEW.session_id));
END;
CREATE TRIGGER delivery_trajectories_delete AFTER DELETE ON trajectories
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'trajectory',OLD.rowid,'trajectory',OLD.id,json_array('trajectory',OLD.id),json_object('id',OLD."id",'version',OLD."version",'persona_id',OLD."persona_id",'project_id',OLD."project_id",'task_title',OLD."task_title",'task_description',OLD."task_description",'status',OLD."status",'started_at',OLD."started_at",'completed_at',OLD."completed_at",'decisions_json',OLD."decisions_json",'retrospective_json',OLD."retrospective_json",'search_text',OLD."search_text",'path',OLD."path",'updated_ms',OLD."updated_ms",'timestamp_ms',OLD."timestamp_ms")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='trajectory'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source='trajectory' AND j.member_session=OLD.id) )
 AND (j.bootstrap_kind < 8 OR (j.bootstrap_kind=8 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='trajectory' AND s.row_id=OLD.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'trajectory','trajectory',OLD.id,json_array('trajectory',OLD.id),'delete','null' WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source='trajectory' AND session_id=OLD.id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source='trajectory' AND session_id=OLD.id));
END;
CREATE TRIGGER delivery_trajectories_insert AFTER INSERT ON trajectories
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'trajectory',NEW.rowid,'trajectory',NEW.id,json_array('trajectory',NEW.id),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='trajectory'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source='trajectory' AND j.member_session=NEW.id) )
 AND (j.bootstrap_kind < 8 OR (j.bootstrap_kind=8 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='trajectory' AND s.row_id=NEW.rowid);

 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'trajectory','trajectory',NEW.id,json_array('trajectory',NEW.id),'upsert',json_object('id',NEW."id",'version',NEW."version",'persona_id',NEW."persona_id",'project_id',NEW."project_id",'task_title',NEW."task_title",'task_description',NEW."task_description",'status',NEW."status",'started_at',NEW."started_at",'completed_at',NEW."completed_at",'decisions_json',NEW."decisions_json",'retrospective_json',NEW."retrospective_json",'search_text',NEW."search_text",'path',NEW."path",'updated_ms',NEW."updated_ms",'timestamp_ms',NEW."timestamp_ms") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source='trajectory' AND session_id=NEW.id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source='trajectory' AND session_id=NEW.id));
END;
CREATE TRIGGER delivery_trajectories_update AFTER UPDATE ON trajectories
WHEN EXISTS(SELECT 1 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER))) AND json_object('id',OLD."id",'version',OLD."version",'persona_id',OLD."persona_id",'project_id',OLD."project_id",'task_title',OLD."task_title",'task_description',OLD."task_description",'status',OLD."status",'started_at',OLD."started_at",'completed_at',OLD."completed_at",'decisions_json',OLD."decisions_json",'retrospective_json',OLD."retrospective_json",'search_text',OLD."search_text",'path',OLD."path",'updated_ms',OLD."updated_ms",'timestamp_ms',OLD."timestamp_ms") <> json_object('id',NEW."id",'version',NEW."version",'persona_id',NEW."persona_id",'project_id',NEW."project_id",'task_title',NEW."task_title",'task_description',NEW."task_description",'status',NEW."status",'started_at',NEW."started_at",'completed_at',NEW."completed_at",'decisions_json',NEW."decisions_json",'retrospective_json',NEW."retrospective_json",'search_text',NEW."search_text",'path',NEW."path",'updated_ms',NEW."updated_ms",'timestamp_ms',NEW."timestamp_ms") BEGIN

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'trajectory',OLD.rowid,'trajectory',OLD.id,json_array('trajectory',OLD.id),json_object('id',OLD."id",'version',OLD."version",'persona_id',OLD."persona_id",'project_id',OLD."project_id",'task_title',OLD."task_title",'task_description',OLD."task_description",'status',OLD."status",'started_at',OLD."started_at",'completed_at',OLD."completed_at",'decisions_json',OLD."decisions_json",'retrospective_json',OLD."retrospective_json",'search_text',OLD."search_text",'path',OLD."path",'updated_ms',OLD."updated_ms",'timestamp_ms',OLD."timestamp_ms")
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='trajectory'
 WHERE j.state <> 'cancelled' AND j.bootstrap_done=0 AND OLD.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source='trajectory' AND j.member_session=OLD.id) OR (j.member_source='trajectory' AND j.member_session=NEW.id))
 AND (j.bootstrap_kind < 8 OR (j.bootstrap_kind=8 AND j.bootstrap_rowid < OLD.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='trajectory' AND s.row_id=OLD.rowid);

 INSERT OR IGNORE INTO delivery_shadow(job_id,kind,row_id,source,session_id,record_key,payload)
 SELECT j.id,'trajectory',NEW.rowid,'trajectory',NEW.id,json_array('trajectory',NEW.id),NULL
 FROM (SELECT id,'active' AS state,bootstrap_done,bootstrap_kind,bootstrap_rowid,source AS member_source,session_id AS member_session FROM history_subscriptions UNION ALL SELECT id,'active',bootstrap_done,bootstrap_kind,bootstrap_rowid,NULL,NULL FROM history_exports WHERE expires_at_ms > CAST(unixepoch('subsec')*1000 AS INTEGER)) j JOIN delivery_bootstrap_bounds b ON b.job_id=j.id AND b.kind='trajectory'
 WHERE OLD.rowid <> NEW.rowid AND j.state <> 'cancelled' AND j.bootstrap_done=0 AND NEW.rowid <= b.max_rowid
 AND (j.member_source IS NULL OR (j.member_source='trajectory' AND j.member_session=NEW.id))
 AND (j.bootstrap_kind < 8 OR (j.bootstrap_kind=8 AND j.bootstrap_rowid < NEW.rowid))
 AND NOT EXISTS(SELECT 1 FROM delivery_shadow s WHERE s.job_id=j.id AND s.kind='trajectory' AND s.row_id=NEW.rowid);
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'trajectory','trajectory',OLD.id,json_array('trajectory',OLD.id),'delete','null' WHERE json_array('trajectory',OLD.id) <> json_array('trajectory',NEW.id) AND ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source='trajectory' AND session_id=OLD.id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source='trajectory' AND session_id=OLD.id));
 INSERT INTO delivery_journal(kind,source,session_id,record_key,operation,payload)
 SELECT 'trajectory','trajectory',NEW.id,json_array('trajectory',NEW.id),'upsert',json_object('id',NEW."id",'version',NEW."version",'persona_id',NEW."persona_id",'project_id',NEW."project_id",'task_title',NEW."task_title",'task_description',NEW."task_description",'status',NEW."status",'started_at',NEW."started_at",'completed_at',NEW."completed_at",'decisions_json',NEW."decisions_json",'retrospective_json',NEW."retrospective_json",'search_text',NEW."search_text",'path',NEW."path",'updated_ms',NEW."updated_ms",'timestamp_ms',NEW."timestamp_ms") WHERE ((EXISTS(SELECT 1 FROM history_subscriptions WHERE source IS NULL) OR EXISTS(SELECT 1 FROM history_subscriptions WHERE source='trajectory' AND session_id=NEW.id)) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source='trajectory' AND session_id=NEW.id));
END;
CREATE TRIGGER history_export_pages_cap_insert BEFORE INSERT ON history_export_pages BEGIN
 SELECT CASE WHEN (SELECT retained_bytes+(length(CAST(NEW.payload AS BLOB))+512)>max_retained_bytes FROM delivery_state WHERE singleton=1) THEN RAISE(ABORT,'delivery retention limit exceeded; compact consumed data or raise the retention cap') END;
END;
CREATE TRIGGER history_export_pages_cap_update BEFORE UPDATE ON history_export_pages BEGIN
 SELECT CASE WHEN (SELECT retained_bytes+(length(CAST(NEW.payload AS BLOB))+512)-(length(CAST(OLD.payload AS BLOB))+512)>max_retained_bytes FROM delivery_state WHERE singleton=1) THEN RAISE(ABORT,'delivery retention limit exceeded; compact consumed data or raise the retention cap') END;
END;
CREATE TRIGGER history_export_pages_count_delete AFTER DELETE ON history_export_pages BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes-(length(CAST(OLD.payload AS BLOB))+512) WHERE singleton=1;
END;
CREATE TRIGGER history_export_pages_count_insert AFTER INSERT ON history_export_pages BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes+(length(CAST(NEW.payload AS BLOB))+512) WHERE singleton=1;
END;
CREATE TRIGGER history_export_pages_count_update AFTER UPDATE ON history_export_pages BEGIN
 UPDATE delivery_state SET retained_bytes=retained_bytes+(length(CAST(NEW.payload AS BLOB))+512)-(length(CAST(OLD.payload AS BLOB))+512) WHERE singleton=1;
END;
