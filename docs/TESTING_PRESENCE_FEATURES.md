# Manual Testing Guide: Presence & Cloud Features

This document provides step-by-step testing procedures for the presence indicators, typing indicators, and user profile features in cloud mode.

## Prerequisites

1. **Cloud Mode Setup**: You need access to the cloud-hosted dashboard with GitHub OAuth authentication.
2. **Multiple Test Accounts**: Ideally 2-3 different GitHub accounts to test multi-user features.
3. **Multiple Browser Windows**: Use different browsers or incognito windows for simultaneous sessions.

---

## Test 1: GitHub Avatar & Username Display

### Objective
Verify that logged-in users see their GitHub avatar and username in messages.

### Steps

1. Log in to the cloud dashboard using GitHub OAuth
2. Send a message to any agent (e.g., `@AgentName Hello`)
3. Observe the message in the chat

### Expected Results

- [ ] Your GitHub avatar appears next to your sent message
- [ ] Your GitHub username appears as the sender
- [ ] Messages display "You" or your username consistently

---

## Test 2: Presence Indicator - Single User

### Objective
Verify presence tracking works for a single user.

### Steps

1. Log in to the cloud dashboard
2. Look at the header area below the main header

### Expected Results

- [ ] A green dot indicator appears showing online status
- [ ] Your avatar appears in the stacked avatar row
- [ ] "1 online" text displays next to the avatars
- [ ] Clicking the indicator shows a dropdown with your username

---

## Test 3: Presence Indicator - Multiple Users

### Objective
Verify multiple users can see each other's presence.

### Steps

1. **User A**: Log in with first GitHub account in Browser 1
2. **User B**: Log in with second GitHub account in Browser 2 (different browser or incognito)
3. Both users observe the presence indicator

### Expected Results

- [ ] Both users see "2 online" in the presence indicator
- [ ] Both avatars appear in the stacked row
- [ ] Clicking shows both usernames in the dropdown
- [ ] Each user can see the other's GitHub avatar

---

## Test 4: Presence Join/Leave Detection

### Objective
Verify real-time updates when users join and leave.

### Steps

1. **User A**: Already logged in
2. **User B**: Log in to dashboard
3. Observe User A's screen when User B joins
4. **User B**: Close the browser tab
5. Observe User A's screen after User B leaves

### Expected Results

- [ ] User A immediately sees count increase when User B joins
- [ ] User B's avatar appears in User A's presence list
- [ ] User A immediately sees count decrease when User B leaves
- [ ] User B's avatar disappears from User A's presence list

---

## Test 5: Multi-Tab Support

### Objective
Verify a user stays "online" when they have multiple tabs open.

### Steps

1. **User A**: Log in to dashboard in Tab 1
2. **User A**: Open a second tab to the same dashboard (Tab 2)
3. **User B**: Log in from a different browser
4. Observe presence count (should show 2 users, not 3)
5. **User A**: Close Tab 1
6. Observe presence (User A should still show as online)
7. **User A**: Close Tab 2
8. Observe presence (User A should now show as offline)

### Expected Results

- [ ] Multiple tabs from same user don't inflate online count
- [ ] Closing one tab doesn't disconnect the user
- [ ] User only shows as offline when ALL tabs are closed

---

## Test 6: Typing Indicator - Single User

### Objective
Verify typing indicators appear when another user is typing.

### Steps

1. **User A**: Log in in Browser 1
2. **User B**: Log in in Browser 2
3. **User B**: Start typing a message (don't send)
4. Observe User A's screen

### Expected Results

- [ ] User A sees "User B is typing..." indicator
- [ ] The indicator appears below the message list, above the composer
- [ ] User B's avatar appears in the typing indicator
- [ ] Animated dots appear next to the message

---

## Test 7: Typing Indicator - Stop Typing

### Objective
Verify typing indicator disappears when user stops typing.

### Steps

1. Continue from Test 6
2. **User B**: Delete all text from the input field
3. Observe User A's screen

### Expected Results

- [ ] Typing indicator disappears within 1 second
- [ ] No residual "typing" state shown

---

## Test 8: Typing Indicator - Auto-Clear

### Objective
Verify typing indicator auto-clears after 3 seconds of inactivity.

### Steps

1. **User A**: Log in in Browser 1
2. **User B**: Log in in Browser 2
3. **User B**: Type something and then stop (don't clear input)
4. Wait 3-4 seconds

### Expected Results

- [ ] Typing indicator disappears after ~3 seconds of no typing activity
- [ ] This prevents stale "typing" states

---

## Test 9: User Profile Panel - Open

### Objective
Verify the user profile panel opens when clicking on an online user.

### Steps

1. Have at least 2 users logged in
2. Click on the online users indicator
3. Click on another user's name/avatar in the dropdown

### Expected Results

- [ ] A slide-out panel appears from the right
- [ ] Panel shows the user's large avatar
- [ ] Panel shows the user's GitHub username
- [ ] Panel shows "Online" status with green indicator
- [ ] Panel shows "Online Since" timestamp
- [ ] Panel shows "Last Active" timestamp
- [ ] Panel shows GitHub link

---

## Test 10: User Profile Panel - Actions

### Objective
Verify profile panel action buttons work correctly.

### Steps

1. Open a user's profile panel (from Test 9)
2. Click the "Mention @username" button
3. Close the panel and open it again
4. Click the "View on GitHub" button

### Expected Results

- [ ] "Mention" button closes panel (TODO: should insert @username in composer)
- [ ] "View on GitHub" opens new tab to user's GitHub profile
- [ ] GitHub profile URL is correctly formatted

---

## Test 11: User Profile Panel - Close Methods

### Objective
Verify all methods of closing the profile panel work.

### Steps

1. Open a user's profile panel
2. Click the X button in the panel header
3. Open the panel again
4. Press the Escape key
5. Open the panel again
6. Click outside the panel (on the backdrop)

### Expected Results

- [ ] X button closes the panel
- [ ] Escape key closes the panel
- [ ] Clicking backdrop closes the panel

---

## Test 12: Human User Autocomplete

### Objective
Verify human users appear in @ mention autocomplete.

### Steps

1. Have User A and User B both logged in
2. Have User A send at least one message
3. **User B**: Start typing `@` in the message input
4. Observe the autocomplete dropdown

### Expected Results

- [ ] User A appears in the autocomplete list
- [ ] Human users show with purple color and person icon
- [ ] Human users are labeled as "Human user"
- [ ] Selecting a human user inserts @username in message

---

## Test 13: Input Validation - Invalid Username

### Objective
Verify the server rejects invalid usernames (security feature).

### Steps

This test requires developer tools or a custom client:

1. Open browser developer tools
2. Find the presence WebSocket connection
3. Try to send a join message with an invalid username (e.g., containing special characters)

### Expected Results

- [ ] Server rejects the invalid username
- [ ] No error is displayed to the user (silent rejection)
- [ ] Console logs show "Invalid username rejected"

---

## Test 14: Security - Cannot Remove Other Users

### Objective
Verify users cannot forcibly remove others from online list.

### Steps

This test requires developer tools:

1. User A and User B both logged in
2. Using developer tools, try to send a leave message with User B's username from User A's connection

### Expected Results

- [ ] Server rejects the leave attempt
- [ ] User B remains in the online list
- [ ] Console logs show security warning

---

## Troubleshooting

### Presence Not Updating

1. Check browser console for WebSocket errors
2. Verify `/ws/presence` WebSocket is connected
3. Refresh the page to reconnect

### Typing Indicator Stuck

1. This may indicate a WebSocket issue
2. Typing indicators auto-clear after 3 seconds
3. Refresh to reset

### Profile Panel Not Opening

1. Ensure you're clicking on a user, not just the indicator
2. Check for JavaScript errors in console

---

## Notes

- All presence features require cloud mode (GitHub OAuth login)
- Local mode does not support multi-user presence
- WebSocket connections may take a moment to establish on page load
