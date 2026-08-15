import { relations } from "drizzle-orm/relations";
import { vessels, cadenceRules, regulatoryProfileAssignments, enrollments, ruleSeverityAssignments, bundleAssignments, configBundles, vesselCredentials, vesselSyncStatus, reportAuditEvents, invalidationNotices, chatMessages, remarks, reportAttachments, fieldPolicyAssignments, restoreCommands, userCommands, apiKeys, apiKeyEvents, attachmentUploads, attachmentUploadChunks, users, notificationReadState, outboxReceipts, reportReviews, vesselUsers, reportVersions } from "./schema";

export const cadenceRulesRelations = relations(cadenceRules, ({one}) => ({
	vessel: one(vessels, {
		fields: [cadenceRules.vesselId],
		references: [vessels.id]
	}),
}));

export const vesselsRelations = relations(vessels, ({many}) => ({
	cadenceRules: many(cadenceRules),
	regulatoryProfileAssignments: many(regulatoryProfileAssignments),
	enrollments: many(enrollments),
	ruleSeverityAssignments: many(ruleSeverityAssignments),
	bundleAssignments: many(bundleAssignments),
	vesselCredentials: many(vesselCredentials),
	vesselSyncStatuses: many(vesselSyncStatus),
	reportAuditEvents: many(reportAuditEvents),
	invalidationNotices: many(invalidationNotices),
	chatMessages: many(chatMessages),
	remarks: many(remarks),
	reportAttachments: many(reportAttachments),
	fieldPolicyAssignments: many(fieldPolicyAssignments),
	restoreCommands: many(restoreCommands),
	userCommands: many(userCommands),
	outboxReceipts: many(outboxReceipts),
	reportReviews: many(reportReviews),
	vesselUsers: many(vesselUsers),
	reportVersions: many(reportVersions),
}));

export const regulatoryProfileAssignmentsRelations = relations(regulatoryProfileAssignments, ({one}) => ({
	vessel: one(vessels, {
		fields: [regulatoryProfileAssignments.vesselId],
		references: [vessels.id]
	}),
}));

export const enrollmentsRelations = relations(enrollments, ({one}) => ({
	vessel: one(vessels, {
		fields: [enrollments.vesselId],
		references: [vessels.id]
	}),
}));

export const ruleSeverityAssignmentsRelations = relations(ruleSeverityAssignments, ({one}) => ({
	vessel: one(vessels, {
		fields: [ruleSeverityAssignments.vesselId],
		references: [vessels.id]
	}),
}));

export const bundleAssignmentsRelations = relations(bundleAssignments, ({one}) => ({
	vessel: one(vessels, {
		fields: [bundleAssignments.vesselId],
		references: [vessels.id]
	}),
	configBundle: one(configBundles, {
		fields: [bundleAssignments.bundleId],
		references: [configBundles.id]
	}),
}));

export const configBundlesRelations = relations(configBundles, ({many}) => ({
	bundleAssignments: many(bundleAssignments),
}));

export const vesselCredentialsRelations = relations(vesselCredentials, ({one}) => ({
	vessel: one(vessels, {
		fields: [vesselCredentials.vesselId],
		references: [vessels.id]
	}),
}));

export const vesselSyncStatusRelations = relations(vesselSyncStatus, ({one}) => ({
	vessel: one(vessels, {
		fields: [vesselSyncStatus.vesselId],
		references: [vessels.id]
	}),
}));

export const reportAuditEventsRelations = relations(reportAuditEvents, ({one}) => ({
	vessel: one(vessels, {
		fields: [reportAuditEvents.vesselId],
		references: [vessels.id]
	}),
}));

export const invalidationNoticesRelations = relations(invalidationNotices, ({one}) => ({
	vessel: one(vessels, {
		fields: [invalidationNotices.vesselId],
		references: [vessels.id]
	}),
}));

export const chatMessagesRelations = relations(chatMessages, ({one}) => ({
	vessel: one(vessels, {
		fields: [chatMessages.vesselId],
		references: [vessels.id]
	}),
}));

export const remarksRelations = relations(remarks, ({one}) => ({
	vessel: one(vessels, {
		fields: [remarks.vesselId],
		references: [vessels.id]
	}),
}));

export const reportAttachmentsRelations = relations(reportAttachments, ({one}) => ({
	vessel: one(vessels, {
		fields: [reportAttachments.vesselId],
		references: [vessels.id]
	}),
}));

export const fieldPolicyAssignmentsRelations = relations(fieldPolicyAssignments, ({one}) => ({
	vessel: one(vessels, {
		fields: [fieldPolicyAssignments.vesselId],
		references: [vessels.id]
	}),
}));

export const restoreCommandsRelations = relations(restoreCommands, ({one}) => ({
	vessel: one(vessels, {
		fields: [restoreCommands.vesselId],
		references: [vessels.id]
	}),
}));

export const userCommandsRelations = relations(userCommands, ({one}) => ({
	vessel: one(vessels, {
		fields: [userCommands.vesselId],
		references: [vessels.id]
	}),
}));

export const apiKeyEventsRelations = relations(apiKeyEvents, ({one}) => ({
	apiKey: one(apiKeys, {
		fields: [apiKeyEvents.apiKeyId],
		references: [apiKeys.id]
	}),
}));

export const apiKeysRelations = relations(apiKeys, ({many}) => ({
	apiKeyEvents: many(apiKeyEvents),
}));

export const attachmentUploadChunksRelations = relations(attachmentUploadChunks, ({one}) => ({
	attachmentUpload: one(attachmentUploads, {
		fields: [attachmentUploadChunks.contentHash],
		references: [attachmentUploads.contentHash]
	}),
}));

export const attachmentUploadsRelations = relations(attachmentUploads, ({many}) => ({
	attachmentUploadChunks: many(attachmentUploadChunks),
}));

export const notificationReadStateRelations = relations(notificationReadState, ({one}) => ({
	user: one(users, {
		fields: [notificationReadState.userId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	notificationReadStates: many(notificationReadState),
}));

export const outboxReceiptsRelations = relations(outboxReceipts, ({one}) => ({
	vessel: one(vessels, {
		fields: [outboxReceipts.vesselId],
		references: [vessels.id]
	}),
}));

export const reportReviewsRelations = relations(reportReviews, ({one}) => ({
	vessel: one(vessels, {
		fields: [reportReviews.vesselId],
		references: [vessels.id]
	}),
}));

export const vesselUsersRelations = relations(vesselUsers, ({one}) => ({
	vessel: one(vessels, {
		fields: [vesselUsers.vesselId],
		references: [vessels.id]
	}),
}));

export const reportVersionsRelations = relations(reportVersions, ({one}) => ({
	vessel: one(vessels, {
		fields: [reportVersions.vesselId],
		references: [vessels.id]
	}),
}));