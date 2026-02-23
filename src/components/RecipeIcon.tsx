const SIZES = {
  sm: { px: 24, font: 11, rounded: 'rounded-md' },
  md: { px: 48, font: 18, rounded: 'rounded-lg' },
  lg: { px: 80, font: 28, rounded: 'rounded-lg' },
} as const

interface RecipeIconProps {
  imageUrl?: string | null
  recipeName: string
  coPackerColor?: string | null
  size?: 'sm' | 'md' | 'lg'
}

export default function RecipeIcon({
  imageUrl,
  recipeName,
  coPackerColor,
  size = 'md',
}: RecipeIconProps) {
  const { px, font, rounded } = SIZES[size]
  const letter = (recipeName[0] ?? '?').toUpperCase()
  const bg = coPackerColor ?? '#3B82F6'

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={recipeName}
        className={`${rounded} object-cover flex-shrink-0`}
        style={{ width: px, height: px }}
      />
    )
  }

  return (
    <div
      className={`${rounded} flex flex-shrink-0 items-center justify-center`}
      style={{ width: px, height: px, backgroundColor: bg }}
    >
      <span
        className="font-bold leading-none text-white"
        style={{ fontSize: font }}
      >
        {letter}
      </span>
    </div>
  )
}
