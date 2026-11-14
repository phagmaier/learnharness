import { notFound } from "next/navigation";
import { CourseNotesPage } from "@/components/course-notes";
import { courseNotes, isCourseRefusal, readCourse } from "@/src/server";

export const dynamic = "force-dynamic";

/** A course's Notes tab (fork plan 04 item 8). ?unit= selects a unit (a
 *  unit session's Notes chip). */
export default async function CourseNotesRoute({ params, searchParams }: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ unit?: string }>;
}) {
	const [{ id }, { unit }] = await Promise.all([params, searchParams]);
	const course = readCourse(id);
	if (isCourseRefusal(course)) {
		if (course.status === 404) notFound();
		return (
			<div className="flex h-dvh items-center justify-center p-8">
				<p role="alert" className="max-w-md text-center text-sm text-muted-foreground">{course.error}</p>
			</div>
		);
	}
	return (
		<CourseNotesPage
			key={course.id}
			course={{ id: course.id, title: course.title, units: course.units.map((entry) => ({ status: entry.status })) }}
			initialUnits={courseNotes(course)}
			initialUnitId={typeof unit === "string" ? unit : null}
		/>
	);
}
