export type AuthProvider = 'email' | 'google';

export type BubbleColorTheme = 'slate' | 'cobalt' | 'emerald' | 'indigo' | 'amber';
export type TextSizeMode = 'small' | 'normal' | 'large';

export interface QuestionnaireData {
  role?: string;
  roleOther?: string;
  domain?: string;
  domainOther?: string;
  expectation?: string;
  expectationOther?: string;
  preferredLanguage?: string;
  preferredLanguageOther?: string;
  notes?: string;
}

export interface UserPreferences {
  theme?: 'light' | 'dark';
  bubbleColor?: BubbleColorTheme;
  textSize?: TextSizeMode;
  responseLanguage?: string;
  webSearchDefault?: boolean;
  voiceMode?: boolean;
  voiceName?: 'Zephyr' | 'Kore' | 'Puck' | 'Charon' | 'Fenrir';
  memoryEnabled?: boolean;
  autoScroll?: boolean;
  enterToSend?: boolean;
}

export interface AccountRecord {
  id: string;
  name: string;
  email: string;
  passwordHash?: string;
  authProvider: AuthProvider;
  googleSub?: string;
  emailVerified: boolean;
  disabled: boolean;
  createdAt: number;
  lastActiveAt: number;
  questionnaireCompleted: boolean;
  questionnaireStep: number;
  questionnaire: QuestionnaireData;
  preferences: UserPreferences;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  authProvider: AuthProvider;
  emailVerified: boolean;
  disabled: boolean;
  createdAt: number;
  lastActiveAt: number;
  questionnaireCompleted: boolean;
  questionnaireStep: number;
  questionnaire: QuestionnaireData;
  preferences: UserPreferences;
}

export interface SessionRecord {
  id: string;
  tokenHash: string;
  userId: string;
  client: 'web' | 'apk';
  createdAt: number;
  expiresAt: number;
}

export interface PendingCodeRecord {
  key: string; // `${type}:${email}`
  type: 'register' | 'reset';
  email: string;
  name?: string;
  passwordHash?: string;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  resendCount: number;
  lastSentAt: number;
}

export interface LoginAttemptRecord {
  email: string;
  failedCount: number;
  lockedUntil: number;
}

export interface AuthStateData {
  sessions: SessionRecord[];
  pendingCodes: PendingCodeRecord[];
  loginAttempts: LoginAttemptRecord[];
  dailyUsage: Record<string, number>;
}

export interface StoredUserWorkspace {
  userId: string;
  updatedAt: number;
  conversations: Array<Record<string, unknown> & { id: string; updatedAt: number }>;
  memories: Array<Record<string, unknown> & { id: string }>;
  projects: Array<Record<string, unknown> & { id: string }>;
  deletedConversationIds?: string[];
}
