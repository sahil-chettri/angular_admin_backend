/**
 * seed.ts — Angular Admin Backend
 *
 * Seeding order (respects FK dependencies):
 *   1.  departments
 *   2.  subjects           (derived from teachers.json subject_specialization)
 *   3.  academic_years     (derived from class-list.json semester/dates)
 *   4.  users + teachers   (teachers.json)
 *   5.  users + students   (students.json)
 *   6.  users + employees  (staff.json)
 *   7.  classes            (class-list.json  →  departments, academic_years)
 *   8.  tasks              (task.json        →  users)
 *   9.  events             (holiday.json + holidays.json + calendar.json)
 *  10.  teacher_attendance (teachers-attendance rows from staff-attendance.json)
 *  11.  student_attendance (student-attendance.json → students, classes)
 *  12.  fee_structures     (fees-type.json   →  classes, academic_years)
 *  13.  fee_payments       (fees.json        →  students, fee_structures)
 *  14.  exams              (examSchedule.json→  classes, subjects, academic_years)
 *
 * Skipped files (no schema model / UI-only):
 *   routes.json, adv-tbl-data.json, ngx-data.json, class-timetable.json,
 *   teacher-timetable.json, attendance-sheet.json, todays-attendance.json,
 *   assign-class-teacher.json (broken FKs), lectures.json (broken FKs),
 *   leaves.json (broken FKs), staff-attendance employee_id broken,
 *   employee-salary.json (currency strings + no FK), leave-balance.json,
 *   teacher-leave.json (no teacherId), hostel-*.json, book-status.json,
 *   allAssets.json, stdHomework.json, stdLeaveReq.json, complaint.json,
 *   visitors.json, admission-inquiries.json, contacts.json, calendar.json,
 *   leave-types.json, fees-discount.json
 */

import { PrismaClient, gender_type, priority_level, task_status, event_type, attendance_status, payment_status } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import * as path from "path";
import * as fs from "fs";

const prisma = new PrismaClient();

// ─── helpers ──────────────────────────────────────────────────────────────────

function loadJson<T = any>(filename: string): T {
  const filePath = path.join(__dirname, "data", filename);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

/** "John Deo" → { first: "John", last: "Deo" } */
function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0] ?? "Unknown";
  const last = parts.slice(1).join(" ") || "Unknown";
  return { first, last };
}

/** "male" | "Male" → gender_type */
function toGender(raw: string): gender_type {
  const v = raw.toLowerCase();
  if (v === "female") return gender_type.female;
  if (v === "male") return gender_type.male;
  return gender_type.other;
}

/** Safely parse a date string — returns undefined on empty/null */
function toDate(raw: string | null | undefined): Date | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
}

/** Parse a decimal that may include $ signs or commas: "$2,574" → 2574 */
function parseMoney(raw: string | number): number {
  if (typeof raw === "number") return raw;
  return parseFloat(String(raw).replace(/[$,\s]/g, "")) || 0;
}

/** Slug-safe username from name + index */
function makeUsername(name: string, index: number): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 60) +
    `_${index}`
  );
}

/** Default hashed password for all seeded users */
async function defaultHash(): Promise<string> {
  return bcrypt.hash("Admin@1234", 10);
}

// ─── 1. DEPARTMENTS ───────────────────────────────────────────────────────────

async function seedDepartments() {
  console.log("→ Seeding departments…");
  const raw = loadJson<any[]>("department.json");

  // Deduplicate by name (JSON has repeats)
  const seen = new Set<string>();
  const unique = raw.filter((d) => {
    const name = d.department_name.trim().toLowerCase();
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });

  const created: Record<string, number> = {}; // name → db id

  for (const d of unique) {
    const name = d.department_name.trim().toLowerCase();
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);

    const dept = await prisma.departments.upsert({
      where: { name: capitalized },
      update: {},
      create: {
        name: capitalized,
        code: name.slice(0, 6).toUpperCase(),
        description: `${capitalized} Department`,
      },
    });
    created[name] = dept.id;
  }

  console.log(`   ✓ ${Object.keys(created).length} departments`);
  return created; // { "mathematics": 1, "civil": 2, … }
}

// ─── 2. SUBJECTS ──────────────────────────────────────────────────────────────

async function seedSubjects(deptMap: Record<string, number>) {
  console.log("→ Seeding subjects…");
  const teachers = loadJson<any[]>("teachers.json");

  const uniqueSubjects = [
    ...new Set(teachers.map((t) => t.subject_specialization as string)),
  ];

  const created: Record<string, number> = {}; // name → db id

  for (const subjectName of uniqueSubjects) {
    const code = subjectName.replace(/\s+/g, "").slice(0, 10).toUpperCase();

    const subject = await prisma.subjects.upsert({
      where: { code },
      update: {},
      create: {
        name: subjectName,
        code,
        description: `${subjectName} subject`,
      },
    });
    created[subjectName] = subject.id;
  }

  console.log(`   ✓ ${Object.keys(created).length} subjects`);
  return created; // { "Mathematics": 1, … }
}

// ─── 3. ACADEMIC YEARS ────────────────────────────────────────────────────────

async function seedAcademicYears() {
  console.log("→ Seeding academic_years…");
  const classes = loadJson<any[]>("class-list.json");

  // Derive from class-list semesters — all are "Fall 2024"
  const semestersRaw = [...new Set(classes.map((c) => c.semester as string))];

  const created: Record<string, number> = {};

  for (const semester of semestersRaw) {
    // Derive dates from class records for this semester
    const semClasses = classes.filter((c) => c.semester === semester);
    const startDate = new Date(semClasses[0].startDate);
    const endDate = new Date(semClasses[0].endDate);

    const label = semester; // "Fall 2024"

    const ay = await prisma.academic_years.upsert({
      where: { label },
      update: {},
      create: {
        label,
        start_date: startDate,
        end_date: endDate,
        is_current: true,
      },
    });
    created[label] = ay.id;
  }

  console.log(`   ✓ ${Object.keys(created).length} academic year(s)`);
  return created; // { "Fall 2024": 1 }
}

// ─── 4. TEACHERS (users + teachers) ──────────────────────────────────────────

async function seedTeachers(
  deptMap: Record<string, number>,
  subjectMap: Record<string, number>
) {
  console.log("→ Seeding teachers (users + teachers)…");
  const raw = loadJson<any[]>("teachers.json");
  const passwordHash = await defaultHash();

  // teacher JSON id ("001") → DB UUID
  const idToUuid: Record<string, string> = {};
  // also collect user UUIDs for tasks assignment
  const userUuids: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const { first, last } = splitName(t.name);
    const username = makeUsername(t.name, i + 1);
    const email = t.email.includes("@")
      ? `teacher${i + 1}_${t.email}`   // de-dupe identical demo emails
      : `teacher${i + 1}@school.dev`;

    const deptKey = (t.department as string).toLowerCase();
    const deptId = deptMap[deptKey] ?? null;

    // Upsert user
    const user = await prisma.users.upsert({
      where: { username },
      update: {},
      create: {
        username,
        email,
        password_hash: passwordHash,
        role: "teacher",
        avatar_url: t.img ?? null,
        is_active: t.status?.toLowerCase() === "active",
      },
    });

    userUuids.push(user.id);

    // Upsert teacher profile
    const teacher = await prisma.teachers.upsert({
      where: { user_id: user.id },
      update: {},
      create: {
        user_id: user.id,
        first_name: first,
        last_name: last,
        gender: toGender(t.gender),
        date_of_birth: toDate(t.birthdate),
        phone: t.mobile ?? null,
        address: t.address ?? null,
        department_id: deptId,
        qualification: t.degree ?? null,
        joining_date: toDate(t.hire_date),
        avatar_url: t.img ?? null,
      },
    });

    // Link teacher ↔ subject
    const subjectId = subjectMap[t.subject_specialization] ?? null;
    if (subjectId) {
      await prisma.teacher_subjects.upsert({
        where: {
          teacher_id_subject_id: {
            teacher_id: teacher.id,
            subject_id: subjectId,
          },
        },
        update: {},
        create: { teacher_id: teacher.id, subject_id: subjectId },
      });
    }

    idToUuid[t.id] = teacher.id; // "001" → UUID
  }

  console.log(`   ✓ ${raw.length} teachers + users`);
  return { idToUuid, userUuids };
}

// ─── 5. STUDENTS (users + students) ──────────────────────────────────────────

async function seedStudents(deptMap: Record<string, number>) {
  console.log("→ Seeding students (users + students)…");
  const raw = loadJson<any[]>("students.json");
  const passwordHash = await defaultHash();

  // rollNo → student UUID
  const rollToUuid: Record<string, string> = {};

  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const { first, last } = splitName(s.name);
    const username = makeUsername(s.name + "_stu", i + 1);
    const email = `student${i + 1}_${s.email.includes("@") ? s.email : "student@school.dev"}`;

    // Upsert user
    const user = await prisma.users.upsert({
      where: { username },
      update: {},
      create: {
        username,
        email,
        password_hash: passwordHash,
        role: "student",
        avatar_url: s.img ?? null,
        is_active: s.status?.toLowerCase() === "active",
      },
    });

    // Upsert student profile
    const student = await prisma.students.upsert({
      where: { roll_number: String(s.rollNo) },
      update: {},
      create: {
        user_id: user.id,
        roll_number: String(s.rollNo),
        first_name: first,
        last_name: last,
        gender: toGender(s.gender),
        date_of_birth: toDate(s.date_of_birth),
        phone: s.mobile ?? null,
        parent_phone: s.parent_guardian_mobile ?? null,
        address: s.address ?? null,
        avatar_url: s.img ?? null,
        joining_date: toDate(s.enrollment_date) ?? new Date(),
      },
    });

    rollToUuid[String(s.rollNo)] = student.id;
  }

  console.log(`   ✓ ${raw.length} students + users`);
  return rollToUuid; // { "1": UUID, "2": UUID, … }
}

// ─── 6. EMPLOYEES (users + employees) ────────────────────────────────────────

async function seedEmployees() {
  console.log("→ Seeding employees/staff (users + employees)…");
  const raw = loadJson<any[]>("staff.json");
  const passwordHash = await defaultHash();

  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const { first, last } = splitName(s.name);
    const username = makeUsername(s.name + "_emp", i + 1);
    const email = `staff${i + 1}_${s.email.includes("@") ? s.email : "staff@school.dev"}`;

    const salaryNum = parseMoney(s.salary);

    const user = await prisma.users.upsert({
      where: { username },
      update: {},
      create: {
        username,
        email,
        password_hash: passwordHash,
        role: "employee",
        avatar_url: s.img ?? null,
        is_active: s.status?.toLowerCase() === "active",
      },
    });

    await prisma.employees.upsert({
      where: { user_id: user.id },
      update: {},
      create: {
        user_id: user.id,
        first_name: first,
        last_name: last,
        gender: toGender(s.gender),
        date_of_birth: toDate(s.date_of_birth),
        phone: s.mobile ?? null,
        address: s.address ?? null,
        department_id: null,
        job_title: s.role ?? null,
        joining_date: toDate(s.joining_date),
        salary: salaryNum > 0 ? salaryNum : null,
        avatar_url: s.img ?? null,
        is_active: s.status?.toLowerCase() === "active",
      },
    });
  }

  console.log(`   ✓ ${raw.length} employees + users`);
}

// ─── 7. CLASSES ───────────────────────────────────────────────────────────────

async function seedClasses(
  deptMap: Record<string, number>,
  academicYearMap: Record<string, number>
) {
  console.log("→ Seeding classes…");
  const raw = loadJson<any[]>("class-list.json");

  const nameCounter: Record<string, number> = {};
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const jsonIdToDbId: Record<number, number> = {};
  const nameToDbId: Record<string, number> = {};

  for (const c of raw) {
    const baseName = c.className as string;
    const count = nameCounter[baseName] ?? 0;
    let seedName: string;

    if (count === 0) {
      seedName = baseName;
    } else {
      seedName = `${baseName}-${LETTERS[count - 1]}`;
    }
    nameCounter[baseName] = count + 1;

    const academicYearId =
      academicYearMap[c.semester] ?? Object.values(academicYearMap)[0];

    const dbClass = await prisma.classes.upsert({
      where: {
        name_academic_year_id: {
          name: seedName,
          academic_year_id: academicYearId,
        },
      },
      update: {},
      create: {
        name: seedName,
        academic_year_id: academicYearId,
        department_id: null,
        capacity: c.classCapacity ?? null,
      },
    });

    jsonIdToDbId[c.classId] = dbClass.id;
    if (!nameToDbId[baseName]) {
      nameToDbId[baseName] = dbClass.id;
    }
  }

  console.log(`   ✓ ${raw.length} classes`);
  return { jsonIdToDbId, nameToDbId };
}

// ─── 8. TASKS ─────────────────────────────────────────────────────────────────

async function seedTasks(userUuids: string[]) {
  console.log("→ Seeding tasks…");
  const raw = loadJson<any[]>("task.json");

  // Use first real user UUID from the users table
  const firstUser = await prisma.users.findFirst({ orderBy: { created_at: "asc" } });
  const defaultAssignee = firstUser?.id ?? (userUuids[0] ?? null);

  for (const t of raw) {
    const priority = (t.priority as string) as priority_level;
    const status: task_status = t.done ? task_status.Completed : task_status.Pending;

    await prisma.tasks.create({
      data: {
        title: t.title,
        details: t.note ?? null,
        status,
        priority,
        due_date: toDate(t.due_date),
        assigned_to: defaultAssignee,
        assigned_by: defaultAssignee,
      },
    });
  }

  console.log(`   ✓ ${raw.length} tasks`);
}

// ─── 9. EVENTS (holiday.json + holidays.json) ─────────────────────────────────

async function seedEvents() {
  console.log("→ Seeding events…");
  let count = 0;

  const holidays = loadJson<any[]>("holiday.json");
  for (const h of holidays) {
    const eventDate = toDate(h.start_date) ?? new Date();
    await prisma.events.create({
      data: {
        title: h.title,
        event_type: event_type.holiday,
        description: h.description ?? null,
        event_date: eventDate,
        is_all_day: true,
        status: h.status ?? "Upcoming",
      },
    });
    count++;
  }

  const schoolHolidays = loadJson<any[]>("holidays.json");
  for (const h of schoolHolidays) {
    const eventDate = toDate(h.date) ?? new Date();
    await prisma.events.create({
      data: {
        title: h.holidayName,
        event_type: event_type.holiday,
        description: h.details ?? null,
        event_date: eventDate,
        is_all_day: true,
        status: h.approvalStatus === "Approved" ? "Upcoming" : "Cancelled",
      },
    });
    count++;
  }

  console.log(`   ✓ ${count} events`);
}

// ─── 10. TEACHER ATTENDANCE ───────────────────────────────────────────────────

async function seedTeacherAttendance(teacherUuidMap: Record<string, string>) {
  console.log("→ Seeding teacher_attendance…");
  const raw = loadJson<any[]>("staff-attendance.json");

  const teacherUuids = Object.values(teacherUuidMap);
  if (teacherUuids.length === 0) {
    console.log("   ⚠ No teachers in DB — skipping teacher_attendance");
    return;
  }

  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    const teacherId = teacherUuids[i % teacherUuids.length];
    const date = toDate(row.date);
    if (!date) continue;

    const statusRaw = (row.attendance_status as string).toLowerCase();
    let status: attendance_status;
    if (statusRaw === "present") status = attendance_status.present;
    else if (statusRaw === "absent") status = attendance_status.absent;
    else if (statusRaw === "late") status = attendance_status.late;
    else status = attendance_status.excused;

    await prisma.teacher_attendance.upsert({
      where: {
        teacher_id_date: { teacher_id: teacherId, date },
      },
      update: {},
      create: {
        teacher_id: teacherId,
        date,
        status,
        remarks: row.remarks && row.remarks !== "N/A" ? row.remarks : null,
      },
    });
    count++;
  }

  console.log(`   ✓ ${count} teacher attendance records`);
}

// ─── 11. STUDENT ATTENDANCE ───────────────────────────────────────────────────

async function seedStudentAttendance(
  rollToUuid: Record<string, string>,
  nameToClassId: Record<string, number>,
  subjectMap: Record<string, number>
) {
  console.log("→ Seeding student_attendance…");
  const raw = loadJson<any[]>("student-attendance.json");

  const dbClasses = await prisma.classes.findMany({
    orderBy: { id: "asc" },
    take: 6,
  });
  const classLetterMap: Record<string, number> = {
    "Class A": dbClasses[0]?.id ?? 1,
    "Class B": dbClasses[1]?.id ?? 1,
    "Class C": dbClasses[2]?.id ?? 1,
    "Class D": dbClasses[3]?.id ?? 1,
    "Class E": dbClasses[4]?.id ?? 1,
    "Class F": dbClasses[5]?.id ?? 1,
  };

  let count = 0;
  for (const row of raw) {
    const studentId = rollToUuid[String(row.rollNo)];
    if (!studentId) continue;

    const classId = classLetterMap[row.class] ?? dbClasses[0]?.id;
    if (!classId) continue;

    const date = toDate(row.date);
    if (!date) continue;

    const subjectId = subjectMap["Mathematics"] ?? null;

    const statusRaw = (row.status as string).toLowerCase();
    let status: attendance_status;
    if (statusRaw === "present") status = attendance_status.present;
    else if (statusRaw === "absent") status = attendance_status.absent;
    else if (statusRaw === "late") status = attendance_status.late;
    else status = attendance_status.excused;

    try {
      await prisma.student_attendance.upsert({
        where: {
          student_id_subject_id_date: {
            student_id: studentId,
            subject_id: subjectId ?? 0,
            date,
          },
        },
        update: {},
        create: {
          student_id: studentId,
          class_id: classId,
          subject_id: subjectId,
          date,
          status,
          remarks: row.note && row.note !== "" ? row.note : null,
        },
      });
      count++;
    } catch {
      // skip duplicates silently
    }
  }

  console.log(`   ✓ ${count} student attendance records`);
}

// ─── 12. FEE STRUCTURES ───────────────────────────────────────────────────────

async function seedFeeStructures(
  academicYearMap: Record<string, number>,
  nameToClassId: Record<string, number>
) {
  console.log("→ Seeding fee_structures…");
  const raw = loadJson<any[]>("fees-type.json");

  const academicYearId = Object.values(academicYearMap)[0];

  const firstClass = await prisma.classes.findFirst({ orderBy: { id: "asc" } });
  const defaultClassId = firstClass?.id ?? 1;

  const feeLabelToId: Record<string, number> = {};

  for (const ft of raw) {
    const label = ft.feeTypeName as string;
    const amount = parseMoney(ft.amount);
    const dueDate = toDate(ft.lastUpdated);

    try {
      const feeStruct = await prisma.fee_structures.upsert({
        where: {
          class_id_academic_year_id_fee_label: {
            class_id: defaultClassId,
            academic_year_id: academicYearId,
            fee_label: label,
          },
        },
        update: {},
        create: {
          class_id: defaultClassId,
          academic_year_id: academicYearId,
          fee_label: label,
          amount,
          due_date: dueDate,
        },
      });
      feeLabelToId[label.toLowerCase()] = feeStruct.id;
    } catch {
      // skip on constraint collision
    }
  }

  // Ensure "Annual Fee" exists (used by fees.json)
  const annualKey = "annual fee";
  if (!feeLabelToId[annualKey]) {
    const annual = await prisma.fee_structures.upsert({
      where: {
        class_id_academic_year_id_fee_label: {
          class_id: defaultClassId,
          academic_year_id: academicYearId,
          fee_label: "Annual Fee",
        },
      },
      update: {},
      create: {
        class_id: defaultClassId,
        academic_year_id: academicYearId,
        fee_label: "Annual Fee",
        amount: 10000,
        due_date: null,
      },
    });
    feeLabelToId[annualKey] = annual.id;
  }

  console.log(`   ✓ ${raw.length + 1} fee_structures`);
  return feeLabelToId;
}

// ─── 13. FEE PAYMENTS ─────────────────────────────────────────────────────────

async function seedFeePayments(
  rollToUuid: Record<string, string>,
  feeLabelToId: Record<string, number>
) {
  console.log("→ Seeding fee_payments…");
  const raw = loadJson<any[]>("fees.json");

  const typeToLabel: Record<string, string> = {
    library: "library fee",
    tuition: "tuition fee",
    transport: "transport fee",
    exam: "examination fee",
    annual: "annual fee",
    other: "miscellaneous fee",
  };

  let count = 0;
  for (const row of raw) {
    const studentId = rollToUuid[String(row.rollNo)];
    if (!studentId) continue;

    const feeLabel = typeToLabel[(row.feesType as string).toLowerCase()] ?? "miscellaneous fee";
    const feeStructureId = feeLabelToId[feeLabel];
    if (!feeStructureId) continue;

    const amountPaid = parseMoney((row.amount as string).replace("$", ""));

    const paymentStatus: payment_status =
      (row.status as string).toLowerCase() === "paid"
        ? payment_status.paid
        : payment_status.unpaid;

    const paymentMethod =
      row.paymentType && row.paymentType !== "" ? row.paymentType : null;

    const paymentDate =
      toDate(row.paymentDate) ?? (paymentStatus === payment_status.paid ? new Date() : undefined);

    await prisma.fee_payments.create({
      data: {
        student_id: studentId,
        fee_structure_id: feeStructureId,
        amount_paid: amountPaid,
        payment_date: paymentDate ?? new Date(),
        payment_status: paymentStatus,
        payment_method: paymentMethod,
        transaction_ref: row.invoiceNo ?? null,
        remarks: row.notes && row.notes !== "N/A" ? row.notes : null,
      },
    });
    count++;
  }

  console.log(`   ✓ ${count} fee_payments`);
}

// ─── 14. EXAMS ────────────────────────────────────────────────────────────────

async function seedExams(
  subjectMap: Record<string, number>,
  academicYearMap: Record<string, number>
) {
  console.log("→ Seeding exams…");
  const raw = loadJson<any[]>("examSchedule.json");

  const academicYearId = Object.values(academicYearMap)[0];
  const firstClass = await prisma.classes.findFirst({ orderBy: { id: "asc" } });
  const defaultClassId = firstClass?.id ?? null;

  for (const row of raw) {
    const subjectName = row.subject as string;
    if (!subjectMap[subjectName]) {
      const code = subjectName.replace(/\s+/g, "").slice(0, 10).toUpperCase();
      const sub = await prisma.subjects.upsert({
        where: { code },
        update: {},
        create: { name: subjectName, code },
      });
      subjectMap[subjectName] = sub.id;
    }
  }

  let count = 0;
  for (const row of raw) {
    const subjectId = subjectMap[row.subject] ?? null;
    const examDate = toDate(row.date) ?? new Date();

    const maxMarks = parseFloat(row.totalMarks) || 100;
    const passMarks = parseFloat(row.reqMarks) || 35;

    await prisma.exams.create({
      data: {
        title: `${row.subject} Exam — ${row.class}`,
        class_id: defaultClassId,
        subject_id: subjectId,
        exam_type: "Written",
        start_date: examDate,
        end_date: examDate,
        max_marks: maxMarks,
        pass_marks: passMarks,
        academic_year_id: academicYearId,
      },
    });
    count++;
  }

  console.log(`   ✓ ${count} exams`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🌱 Starting seed…\n");

  // Wave 1 — no dependencies
  const deptMap = await seedDepartments();
  const subjectMap = await seedSubjects(deptMap);
  const academicYearMap = await seedAcademicYears();

  // Wave 2 — depends on departments / subjects
  const { idToUuid: teacherUuidMap, userUuids } = await seedTeachers(deptMap, subjectMap);
  const rollToUuid = await seedStudents(deptMap);
  await seedEmployees();

  // Wave 3 — depends on academic_years + departments
  const { jsonIdToDbId, nameToDbId } = await seedClasses(deptMap, academicYearMap);

  // Wave 4 — depends on users / classes
  await seedTasks(userUuids);
  await seedEvents();
  await seedTeacherAttendance(teacherUuidMap);
  await seedStudentAttendance(rollToUuid, nameToDbId, subjectMap);

  // Wave 5 — depends on classes + academic_years
  const feeLabelToId = await seedFeeStructures(academicYearMap, nameToDbId);

  // Wave 6 — depends on students + fee_structures
  await seedFeePayments(rollToUuid, feeLabelToId);

  // Wave 7 — depends on classes + subjects + academic_years
  await seedExams(subjectMap, academicYearMap);

  console.log("\n✅ Seed complete!\n");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());