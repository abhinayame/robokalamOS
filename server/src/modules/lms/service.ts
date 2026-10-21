import { exec, queryOne, type Db } from '../../db/pool.js';
import { issueCertificate } from '../certificates/service.js';

/** Where an enrollment stands: required lessons done over required lessons, as whole percent. */
export async function standing(enrollmentId: string, courseId: string, db?: Db) {
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_lessons WHERE course_id = $1 AND required = TRUE AND deleted_at IS NULL`, [courseId], db))!.n);
  const done = Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_progress p JOIN lms_lessons l ON l.id = p.lesson_id AND l.deleted_at IS NULL AND l.required = TRUE WHERE p.enrollment_id = $1 AND p.completed_at IS NOT NULL`, [enrollmentId], db))!.n);
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * Called after every finished lesson. When every required lesson is done the enrollment is completed once (and stays completed even
 * if lessons are added later), and a learner whose course names a certificate design receives it automatically.
 */
export async function afterProgress(db: Db, enr: { id: string; org_id: string; course_id: string; learner_id: string | null; completed_at: any }) {
  const st = await standing(enr.id, enr.course_id, db);
  await exec(`UPDATE lms_enrollments SET last_activity_at = NOW(3), started_at = COALESCE(started_at, NOW(3)) WHERE id = $1`, [enr.id], db);
  let justCompleted = false; let certificateCode: string | null = null;
  if (!enr.completed_at && st.total > 0 && st.done >= st.total) {
    const r = await exec(`UPDATE lms_enrollments SET status = 'completed', completed_at = NOW(3) WHERE id = $1 AND completed_at IS NULL`, [enr.id], db);
    justCompleted = r.affectedRows > 0;
    if (justCompleted && enr.learner_id) {
      const course = await queryOne(`SELECT id, title, certificate_design_id FROM lms_courses WHERE id = $1`, [enr.course_id], db);
      const design = course?.certificate_design_id ? await queryOne(`SELECT * FROM certificate_designs WHERE id = $1 AND org_id = $2 AND status = 'active'`, [course.certificate_design_id, enr.org_id], db) : null;
      if (design) {
        const learner = await queryOne(`SELECT id, full_name FROM learners WHERE id = $1`, [enr.learner_id], db);
        const org = await queryOne(`SELECT name FROM organizations WHERE id = $1`, [enr.org_id], db);
        const id = await issueCertificate(db, { orgId: enr.org_id, orgName: org?.name ?? '', design, learner: learner!, date: new Date().toISOString().slice(0, 10), issuedBy: null, courseName: course!.title });
        if (id) certificateCode = (await queryOne(`SELECT code FROM certificates WHERE id = $1`, [id], db))?.code ?? null;
      }
    }
  }
  return { ...st, justCompleted, certificateCode, completed: !!enr.completed_at || justCompleted };
}
