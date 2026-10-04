-- Phase 9: covering indexes found by running the hot endpoints against 100k learners / 1,500 batches / 800k attendance rows.
-- Covering = the aggregate is answered from the index alone, without touching table rows.
ALTER TABLE attendance            ADD KEY idx_attendance_cov (batch_id, session_id, learner_id, status);
ALTER TABLE scores                ADD KEY idx_scores_cov (batch_id, deleted_at, learner_id, score, max_score);
ALTER TABLE scores                ADD KEY idx_scores_org_updated (org_id, deleted_at, updated_at);
ALTER TABLE xp_transactions       ADD KEY idx_xp_batch_points (batch_id, points);
ALTER TABLE learner_batch_memberships ADD KEY idx_lbm_cov (batch_id, learner_id, status);
ALTER TABLE submissions           ADD KEY idx_sub_cov (assignment_id, learner_id, status);
ALTER TABLE learner_badges        ADD KEY idx_lb_batch_active (batch_id, revoked_at);
