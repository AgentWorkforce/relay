# Channels V1 - Troubleshooting Guide

Common issues during development and integration, with solutions.

## Backend Issues

### Problem: Migrations won't apply
**Symptoms:** Server fails to start, "migration failed" error

**Causes:**
- Duplicate migration files
- Migration already applied (check `__drizzle_migrations` table)
- SQL syntax error in migration file

**Solutions:**
1. Check the journal: `src/cloud/db/migrations/meta/_journal.json`
2. Verify migration file exists: `src/cloud/db/migrations/0012_*.sql`
3. Check database: `SELECT * FROM __drizzle_migrations;`
4. If migration is listed but should re-run:
   - Delete from journal
   - Delete migration file
   - Re-run: `npm run db:migrate`

---

### Problem: TypeScript errors in channels.ts
**Symptoms:** `npm run build` fails with TS errors

**Causes:**
- Type mismatch on filter operations
- Missing type guards
- Incorrect import paths
- TypeScript cache not cleared after schema changes

**Solutions:**
1. Clear TypeScript cache and rebuild:
   ```bash
   npm run clean
   npm run build
   ```
2. Verify types are imported correctly:
   ```typescript
   import { Channel, ChannelMember } from '../db/index.js';
   ```
3. Check line number in error message
4. Use type guards on filter: `.filter((c): c is Channel => c !== null)`
5. If still failing, check schema.ts exports the types

**Common Error:**
- `schema.channels does not exist on type` → Run `npm run clean`
- Missing type imports → Check db/index.ts exports them

**Example:**
```typescript
// WRONG - TypeScript doesn't know type after filter
const filtered = channels.filter(Boolean);

// RIGHT - Type guard tells TypeScript the type
const filtered = channels.filter((c): c is Channel => c !== null);
```

**Root Cause:** When schema.ts is modified to add new tables, db/index.ts needs to export the new types. If TypeScript cache isn't cleared, it sees old type definitions.

---

### Problem: API endpoints return 500 errors
**Symptoms:** Frontend sees 500 Internal Server Error

**Causes:**
- Database query error
- Missing database column
- Type mismatch in response

**Solutions:**
1. Check server logs: Look for error messages
2. Verify database schema: Run `npm run db:studio` to inspect tables
3. Check channel_read_state table exists with all columns
4. Verify migration 0013 added topic and last_activity_at
5. Test endpoint manually: `curl -H "Authorization: Bearer TOKEN" http://localhost:3000/api/workspaces/ws-id/channels`

---

### Problem: Unread count wrong or not updating
**Symptoms:** unreadCount always 0 or doesn't change

**Causes:**
- Mark read endpoint not called
- last_read_at not updating
- Unread query calculating wrong

**Solutions:**
1. Verify POST /read endpoint is called when messages viewed
2. Check database:
   ```sql
   SELECT * FROM channel_read_state WHERE user_id = 'your-id' AND channel_id = 'ch-id';
   ```
3. Check last_read_at timestamp is recent
4. Manually test unread calculation:
   ```sql
   SELECT COUNT(*) FROM channel_messages
   WHERE channel_id = 'ch-id'
   AND created_at > (SELECT last_read_at FROM channel_read_state WHERE user_id = 'your-id' AND channel_id = 'ch-id');
   ```

---

### Problem: Member count wrong
**Symptoms:** memberCount shows wrong number

**Causes:**
- Not incrementing on join
- Not decrementing on leave
- Database state out of sync

**Solutions:**
1. Check channels table:
   ```sql
   SELECT id, name, member_count FROM channels WHERE name = 'test-channel';
   ```
2. Count actual members:
   ```sql
   SELECT COUNT(*) FROM channel_members WHERE channel_id = 'ch-id';
   ```
3. If mismatch, fix manually:
   ```sql
   UPDATE channels SET member_count = (
     SELECT COUNT(*) FROM channel_members WHERE channel_id = channels.id
   ) WHERE id = 'ch-id';
   ```
4. Add logging to join/leave endpoints to debug

---

## Frontend Issues

### Problem: Components don't render
**Symptoms:** Blank screen or component missing

**Causes:**
- Component not imported
- Missing props
- CSS classes not applied
- Error in component code

**Solutions:**
1. Check browser console for errors
2. Verify component is imported correctly
3. Verify Tailwind CSS is working (check class names apply)
4. Use React DevTools to inspect component tree
5. Check that types match API responses

---

### Problem: API calls fail with 401 Unauthorized
**Symptoms:** All API calls return 401

**Causes:**
- Session expired
- User not logged in
- Wrong workspace ID

**Solutions:**
1. Verify you're logged in
2. Check session cookie exists
3. Verify workspaceId is correct (not placeholder)
4. Log the workspace ID in component to verify:
   ```javascript
   console.log('workspaceId:', workspaceId);
   ```
5. Check network tab to see actual request URL

---

### Problem: API calls fail with 403 Forbidden
**Symptoms:** API returns "Access denied"

**Causes:**
- Not a member of channel
- No permission for operation
- Read-only user trying to write

**Solutions:**
1. Verify user is member of channel
2. Check user role in channel (need admin for certain ops)
3. Check workspace role (need edit permission to create channels)
4. Verify not read-only user
5. Check API endpoint permissions in channels.ts

---

### Problem: Mock API still being used
**Symptoms:** Changes don't persist across page refresh

**Causes:**
- Component still importing mockApi
- Real API calls not implemented
- Still testing with mock data

**Solutions:**
1. Search for mockApi imports: `grep -r "mockApi" src/dashboard/`
2. Remove mock imports and replace with real API calls
3. Verify fetch calls hit real endpoints: Check network tab in DevTools
4. Verify responses have real data (UUIDs, timestamps, etc.)
5. Check that data persists after refresh

---

### Problem: Component shows error "Cannot read property 'map' of undefined"
**Symptoms:** TypeError when rendering list

**Causes:**
- API response has different structure
- Missing field in response
- Data type mismatch

**Solutions:**
1. Check API response in Network tab
2. Verify response has expected fields
3. Add null checks:
   ```typescript
   const items = response.messages || [];
   const rendered = items.map(...)  // Safe now
   ```
4. Use optional chaining:
   ```typescript
   {messages?.map(m => <div>{m.content}</div>)}
   ```

---

### Problem: Performance is slow
**Symptoms:** UI is laggy, loading lots of messages

**Causes:**
- Loading too many messages at once
- Missing key prop on lists
- Expensive renders

**Solutions:**
1. Implement pagination: Load 50 messages, show "Load More"
2. Add key prop to list items:
   ```typescript
   {messages.map(m => <div key={m.id}>{m.content}</div>)}
   ```
3. Use useMemo for expensive calculations
4. Use useCallback for event handlers
5. Check DevTools Performance tab for slow renders

---

## Integration Issues

### Problem: Frontend types don't match backend response
**Symptoms:** TypeScript errors or data display broken

**Causes:**
- Field names different (e.g., body vs content)
- Missing fields in response
- Type mismatch

**Solutions:**
1. Check API reference for field names
2. Map response fields:
   ```typescript
   const message = {
     from: response.sender_name,
     content: response.body,
     timestamp: response.created_at,
   };
   ```
3. Use type guards to validate response
4. Add console.log to see actual response shape

---

### Problem: Commands don't work
**Symptoms:** `/create-channel` doesn't trigger

**Causes:**
- Command not registered
- Wrong path to handler
- Handler not implemented

**Solutions:**
1. Check CommandPalette.tsx has command registered
2. Verify command name matches (case-sensitive)
3. Check hook returns command in list
4. Test command handler manually
5. Check console for errors when selecting command

---

## Database Issues

### Problem: Database connection fails
**Symptoms:** "Connection refused" error

**Causes:**
- PostgreSQL not running
- Wrong DATABASE_URL
- Port 5432 not accessible

**Solutions:**
1. Check PostgreSQL is running
2. Verify DATABASE_URL in .env
3. Test connection: `psql $DATABASE_URL`
4. If containerized, verify port mapping

---

### Problem: Foreign key constraint violation
**Symptoms:** "violates foreign key constraint"

**Causes:**
- Trying to add member to non-existent channel
- Trying to add non-existent user
- Channel deleted but messages still reference it

**Solutions:**
1. Verify channel exists: `SELECT * FROM channels WHERE id = '...';`
2. Verify user exists: `SELECT * FROM users WHERE id = '...';`
3. Don't delete channels while in use (use archive instead)
4. Use cascading deletes in schema (already configured)

---

## Testing Issues

### Problem: Tests fail but manual testing works
**Symptoms:** Integration test fails but feature works in browser

**Causes:**
- Test data different from real data
- Race conditions in async code
- Mock data out of sync

**Solutions:**
1. Compare test data with real data
2. Add delays/waits for async operations
3. Update test data when schema changes
4. Use real API endpoints in tests (not mocks)

---

## Network/Connectivity Issues

### Problem: Network tab shows failed requests
**Symptoms:** Red X on API calls in DevTools

**Causes:**
- Server not running
- Wrong hostname/port
- CORS error
- Network is down

**Solutions:**
1. Verify server is running: `npm start`
2. Check URL is correct (not localhost:3001, etc.)
3. Look for CORS error in console
4. Test with curl: `curl http://localhost:3000/api/`
5. Check network connectivity

---

## Getting Help

If you hit an issue not listed here:

1. **Check the logs:**
   - Server console: `npm start`
   - Browser console: DevTools → Console tab
   - Network tab: DevTools → Network tab

2. **Check the code:**
   - Review API implementation in channels.ts
   - Review component implementation
   - Check type definitions

3. **Ask the team:**
   - ChannelsBackend: API/database questions
   - ChannelsUI: Component/integration questions
   - ChannelsFeatures: Command palette questions
   - Lead: Architecture/coordination questions

4. **Search for similar issues:**
   - Grep the codebase for keywords
   - Check git history for related changes
   - Review documentation files

5. **Reproduce the issue:**
   - Clear browser cache (Cmd+Shift+Delete)
   - Restart server
   - Check database state
   - Try with fresh data

## Debugging Tips

### Enable detailed logging
```typescript
// Add to component
console.log('API response:', response);
console.log('Rendering messages:', messages);
```

### Inspect database state
```bash
npm run db:studio  # Opens GUI for database inspection
```

### Test API endpoint directly
```bash
curl -H "Authorization: Bearer TOKEN" \
  "http://localhost:3000/api/workspaces/ws-id/channels"
```

### Check types match
```typescript
import type { ChannelMessage } from './types';
const message: ChannelMessage = response; // Will error if types don't match
```

### Network throttling (test slow connections)
DevTools → Network → Throttling → Slow 3G

## Escalation Path

1. Try to solve locally (30 min)
2. Ask your team lead
3. Contact other team lead (if cross-team issue)
4. Escalate to coordination lead if blocked
