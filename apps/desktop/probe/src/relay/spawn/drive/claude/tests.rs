use super::*;

fn notice(approvable: bool, options: &[&str]) -> requests::Notice {
    requests::Notice {
        reference: "0123456789abcdef".into(),
        session: "s".into(),
        description: "Claude requests permission to change files.".into(),
        approvable,
        options: options.iter().map(|option| option.to_string()).collect(),
    }
}

#[test]
fn a_relayed_request_names_its_reference_who_may_answer_and_how() {
    assert_eq!(
        approval_text("w1", &notice(true, &[])),
        "[Claude approval 0123456789abcdef for @w1]\n\
         Claude requests permission to change files.\n\
         Reply `approve 0123456789abcdef` or `deny 0123456789abcdef` within five minutes. \
         Only the signed-in machine owner may answer."
    );
    assert!(approval_text("w1", &notice(false, &[]))
        .ends_with("Reply `deny 0123456789abcdef` within five minutes. This question cannot be answered through a Relay DM. Only the signed-in machine owner may answer."));
    assert!(approval_text("w1", &notice(false, &["1: Yes", "2: No"]))
        .contains("Options: 1: Yes, 2: No. Reply `choose 0123456789abcdef <number>`"));
}
