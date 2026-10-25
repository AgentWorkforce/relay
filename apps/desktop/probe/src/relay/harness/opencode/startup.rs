//! A prompt receipt proves queuing, not working model credentials.
use super::*;

pub(super) fn wait(server: &dyn OpenCodeServer, binding: &Binding) -> Result<TaskHandoff, String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match server.startup(binding) {
            Ok(true) => return Ok(TaskHandoff::Confirmed),
            Err(reason) => return Err(super::super::diagnostics::redact(&reason)),
            Ok(false) if Instant::now() >= deadline => {
                return Ok(TaskHandoff::Unconfirmed("model_start_unconfirmed"));
            }
            Ok(false) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

pub(super) fn read(config: &OpenCodeConfig, session: &str) -> Result<bool, String> {
    let Some(database) = open_database(config) else {
        return Ok(false);
    };
    let result = database.query_row(
        "SELECT data FROM message WHERE session_id = ?1 AND json_extract(data, '$.role') = 'assistant' \
         ORDER BY time_created ASC, id ASC LIMIT 1",
        [session], |row| row.get::<_, String>(0),
    );
    let Some(message) = result
        .ok()
        .and_then(|data| serde_json::from_str::<Value>(&data).ok())
    else {
        return Ok(false);
    };
    if let Some(error) = message.get("error").filter(|error| !error.is_null()) {
        let reason = error
            .pointer("/data/message")
            .or_else(|| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("OpenCode's first model call failed");
        return Err(super::super::diagnostics::redact(reason));
    }
    Ok(message
        .pointer("/time/completed")
        .is_some_and(Value::is_number))
}
