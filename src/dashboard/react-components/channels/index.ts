/**
 * Channels V1 Component Library
 *
 * Comprehensive channel-based messaging UI components.
 * Built for the Agent Relay dashboard.
 */

// Types
export * from './types';

// API (real + mock fallback)
export {
  listChannels,
  getChannel,
  getMessages,
  createChannel,
  sendMessage,
  joinChannel,
  leaveChannel,
  archiveChannel,
  unarchiveChannel,
  deleteChannel,
  markRead,
  pinMessage,
  unpinMessage,
  getMentionSuggestions,
  searchMessages,
  searchChannel,
  // Admin API (Task 10)
  updateChannel,
  addMember,
  removeMember,
  updateMemberRole,
  getChannelMembers,
  isRealApiEnabled,
  setApiMode,
  getApiMode,
  ApiError,
} from './api';

// Components
export { ChannelSidebarV1 } from './ChannelSidebarV1';
export { ChannelHeader } from './ChannelHeader';
export { ChannelMessageList } from './ChannelMessageList';
export { MessageInput } from './MessageInput';
export { ChannelViewV1 } from './ChannelViewV1';
export { SearchInput } from './SearchInput';
export { SearchResults } from './SearchResults';

// Dialogs
export {
  ArchiveChannelDialog,
  DeleteChannelDialog,
  LeaveChannelDialog,
  CreateChannelModal,
  // Admin Tools (Task 10)
  ChannelSettingsModal,
  MemberManagementPanel,
} from './ChannelDialogs';

// Re-export prop types for convenience
export type { ChannelSidebarV1Props } from './types';
export type { ChannelHeaderProps } from './types';
export type { ChannelMessageListProps } from './types';
export type { MessageInputProps } from './types';
export type { ChannelViewV1Props } from './ChannelViewV1';
export type { SearchInputProps, SearchResultsProps, SearchResult, SearchResponse } from './types';
export type {
  ArchiveChannelDialogProps,
  DeleteChannelDialogProps,
  LeaveChannelDialogProps,
  CreateChannelModalProps,
  // Admin Tools (Task 10)
  ChannelSettingsModalProps,
  MemberManagementPanelProps,
} from './ChannelDialogs';
