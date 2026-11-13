import { notFound } from "next/navigation";
import { CourseOverview } from "@/components/course-overview";
import { isCourseRefusal, readCourse } from "@/src/server";

export const dynamic = "force-dynamic";

/** A course's overview (fork plan 04 item 3). */
export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const course = readCourse(id);
	if (isCourseRefusal(course)) {
		if (course.status === 404) notFound();
		return (
			<div className="flex h-dvh items-center justify-center p-8">
				<p role="alert" className="max-w-md text-center text-sm text-muted-foreground">{course.error}</p>
			</div>
		);
	}
	return <CourseOverview key={course.id} initialCourse={course} />;
}
