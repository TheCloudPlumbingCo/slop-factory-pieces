/** The GitHub project board that holds the real workflow state. The portal only links to it. Unset = no link shown. */
export const projectBoardUrl: string | undefined = process.env.NEXT_PUBLIC_PROJECT_URL || undefined;
