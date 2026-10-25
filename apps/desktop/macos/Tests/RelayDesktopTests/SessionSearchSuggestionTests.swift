import XCTest
@testable import RelayDesktopCore

final class SessionSearchSuggestionTests: XCTestCase {
    func testCompletesTokensPreservingPriorFiltersAndQuotedValues() {
        XCTAssertEqual(LocalSessionQuery.suggesting("fix is:active har", field: "harness", value: "codex"), "fix is:active harness:codex ")
        XCTAssertEqual(LocalSessionQuery.suggesting("title:\"Fix login\" ", field: "project", value: "my project"), "title:\"Fix login\" project:\"my project\" ")
        XCTAssertEqual(LocalSessionQuery.suggesting("source:claude ", field: "harness", value: "codex"), "source:claude harness:codex ")
    }
    func testSuggestionsAddWithoutReplacingSelectionsOrText() {
        XCTAssertEqual(LocalSessionQuery.suggesting("harness:codex", field: "harness", value: "claude"), "harness:codex harness:claude ")
        XCTAssertEqual(LocalSessionQuery.suggesting("harness:codex ", field: "harness", value: "codex"), "")
        XCTAssertEqual(LocalSessionQuery.suggesting("fix login", field: "is", value: "active"), "fix login is:active ")
        XCTAssertEqual(LocalSessionQuery.suggesting("harness:cl", field: "harness", value: "claude"), "harness:claude ")
    }

    func testDeselectRemovesOnlyThatValueIncludingAliasesAndDuplicates() {
        XCTAssertEqual(LocalSessionQuery.suggesting("fix harness:codex harness:claude is:active", field: "harness", value: "codex"), "fix harness:claude is:active ")
        XCTAssertEqual(LocalSessionQuery.suggesting("source:codex harness:codex -harness:codex harness:claude", field: "harness", value: "codex"), "-harness:codex harness:claude ")
        XCTAssertEqual(LocalSessionQuery.suggesting("project:\"my project\" project:cloud title:\"Fix login\"", field: "project", value: "my project"), "project:cloud title:\"Fix login\" ")
    }

    func testChipRemovalPreservesTextOtherValuesAndExclusions() {
        let query = LocalSessionQuery("fix harness:codex harness:claude -is:inactive project:\"my project\"")
        XCTAssertEqual(query.removingTerm(at: 1), "fix harness:claude -is:inactive project:\"my project\"")
        XCTAssertEqual(query.removingTerm(at: 3), "fix harness:codex harness:claude project:\"my project\"")
        XCTAssertEqual(LocalSessionQuery("is:active").removingTerm(at: 0), "")
    }

    func testRightAddsAndLeftRemovesWithoutTogglingOnRepeat() {
        let added = LocalSessionQuery.selectingSuggestion("is:active", field: "harness", value: "codex", selected: true)
        XCTAssertEqual(added, "is:active harness:codex ")
        XCTAssertEqual(LocalSessionQuery.selectingSuggestion(added, field: "harness", value: "codex", selected: true), added)
        let removed = LocalSessionQuery.selectingSuggestion(added, field: "harness", value: "codex", selected: false)
        XCTAssertEqual(removed, "is:active ")
        XCTAssertEqual(LocalSessionQuery.selectingSuggestion(removed, field: "harness", value: "codex", selected: false), removed)
    }

    func testOppositeFiltersReplaceWhileCompatibleFiltersRemain() {
        XCTAssertEqual(LocalSessionQuery.suggesting("harness:codex is:active is:on-relay", field: "is", value: "inactive"), "harness:codex is:on-relay is:inactive ")
        XCTAssertEqual(LocalSessionQuery.selectingSuggestion("is:inactive", field: "is", value: "active", selected: true), "is:active ")
        XCTAssertEqual(LocalSessionQuery.suggesting("upload:local project:cloud", field: "upload", value: "in-progress"), "project:cloud upload:in-progress ")
        XCTAssertEqual(LocalSessionQuery.suggesting("upload:uploaded", field: "upload", value: "in-progress"), "upload:uploaded upload:in-progress ")
        XCTAssertEqual(LocalSessionQuery.suggesting("upload:none", field: "upload", value: "uploaded"), "upload:uploaded ")
        XCTAssertEqual(LocalSessionQuery.suggesting("is:inactive -is:active project:cloud", field: "is", value: "active"), "project:cloud is:active ")
        XCTAssertEqual(LocalSessionQuery.selectingSuggestion("is:active is:inactive", field: "is", value: "active", selected: true), "is:active ")
        XCTAssertNotNil(LocalSessionQuery("is:active is:inactive").error)
    }

    func testEnterCommitsCompletionInsteadOfTheTypedFragment() {
        XCTAssertEqual(LocalSessionQuery.completingSuggestion("cloud ", field: "project", value: "cloud", title: "cloud"), "project:cloud ")
        XCTAssertEqual(LocalSessionQuery.completingSuggestion("cloud", field: "project", value: "cloud", title: "cloud"), "project:cloud ")
        XCTAssertEqual(LocalSessionQuery.completingSuggestion("fix harness:codex clo", field: "project", value: "cloud", title: "cloud"), "fix harness:codex project:cloud ")
        XCTAssertEqual(LocalSessionQuery.completingSuggestion("fix In pro", field: "upload", value: "in-progress", title: "In progress"), "fix upload:in-progress ")
        XCTAssertEqual(LocalSessionQuery.completingSuggestion("project:\"clo\"", field: "project", value: "cloud", title: "cloud"), "project:cloud ")
        XCTAssertEqual(LocalSessionQuery.completingSuggestion("project:cloud ", field: "project", value: "cloud", title: "cloud"), "project:cloud ")
        XCTAssertEqual(LocalSessionQuery.completingSuggestion("title:cloud", field: "project", value: "cloud", title: "cloud"), "title:cloud project:cloud ")
    }

}
